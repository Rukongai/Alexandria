import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { createLogger } from '../utils/logger.js';
import { validationError, notFound } from '../utils/errors.js';

const logger = createLogger('UploadService');

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

type UploadLifecycle = 'uploading' | 'assembling' | 'consumed' | 'aborted';

interface UploadSession {
  uploadId: string;
  filename: string;
  totalSize: number;
  totalChunks: number;
  receivedChunks: Set<number>;
  chunkSizes: Map<number, number>;
  lockTail: Promise<void>;
  lockRequests: number;
  lockActive: boolean;
  lifecycle: UploadLifecycle;
  chunksDir: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

export class UploadService {
  private sessions = new Map<string, UploadSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this._cleanupExpired(), CLEANUP_INTERVAL_MS);
  }

  initUpload(
    filename: string,
    totalSize: number,
    totalChunks: number,
    userId: string,
  ): { uploadId: string; expiresAt: string } {
    const uploadId = crypto.randomUUID();
    const chunksDir = path.join(os.tmpdir(), `alexandria_chunks_${uploadId}`);
    fs.mkdirSync(chunksDir, { recursive: true });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

    const session: UploadSession = {
      uploadId,
      filename,
      totalSize,
      totalChunks,
      receivedChunks: new Set(),
      chunkSizes: new Map(),
      lockTail: Promise.resolve(),
      lockRequests: 0,
      lockActive: false,
      lifecycle: 'uploading',
      chunksDir,
      userId,
      createdAt: now,
      expiresAt,
    };

    this.sessions.set(uploadId, session);
    logger.info({ uploadId, filename, totalSize, totalChunks }, 'Upload session created');

    return { uploadId, expiresAt: expiresAt.toISOString() };
  }

  async receiveChunk(
    uploadId: string,
    chunkIndex: number,
    dataStream: Readable,
    userId: string,
  ): Promise<{ received: number }> {
    const session = this._getSession(uploadId, userId);
    const releaseLocks = await this._acquireSessionLocks([session]);
    let pendingPath: string | null = null;
    try {
      const lockedSession = this._getSession(uploadId, userId);
      if (lockedSession !== session) {
        throw notFound(`Upload session ${uploadId} not found`);
      }
      this._requireUploading(lockedSession);
      if (chunkIndex >= lockedSession.totalChunks) {
        throw validationError(
          `Chunk index ${chunkIndex} exceeds totalChunks ${lockedSession.totalChunks}`,
        );
      }

      const chunkPath = path.join(lockedSession.chunksDir, `chunk_${chunkIndex}`);
      pendingPath = path.join(
        lockedSession.chunksDir,
        `pending_${chunkIndex}_${crypto.randomUUID()}`,
      );
      const storedWithoutCurrent = [...lockedSession.chunkSizes.entries()].reduce(
        (total, [index, size]) => total + (index === chunkIndex ? 0 : size),
        0,
      );
      const allowedBytes = lockedSession.totalSize - storedWithoutCurrent;
      let received = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > allowedBytes) {
            callback(validationError('Uploaded chunks exceed the declared totalSize'));
            return;
          }
          callback(null, chunk);
        },
      });

      await pipeline(dataStream, limiter, fs.createWriteStream(pendingPath));
      await fs.promises.rename(pendingPath, chunkPath);
      lockedSession.receivedChunks.add(chunkIndex);
      lockedSession.chunkSizes.set(chunkIndex, received);

      logger.debug(
        {
          uploadId,
          chunkIndex,
          bytes: received,
          received: lockedSession.receivedChunks.size,
          total: lockedSession.totalChunks,
        },
        'Chunk received',
      );

      return { received };
    } catch (error) {
      if (pendingPath) {
        await fs.promises.rm(pendingPath, { force: true }).catch(() => {});
      }
      throw error;
    } finally {
      releaseLocks();
    }
  }

  async abortUpload(uploadId: string, userId: string): Promise<void> {
    const session = this._getSession(uploadId, userId);
    const releaseLocks = await this._acquireSessionLocks([session]);
    try {
      const lockedSession = this._getSession(uploadId, userId);
      if (lockedSession !== session) throw notFound(`Upload session ${uploadId} not found`);
      this._requireUploading(lockedSession);
      lockedSession.lifecycle = 'aborted';
      this._removeSession(lockedSession);
      logger.info({ uploadId }, 'Upload session aborted');
    } finally {
      releaseLocks();
    }
  }

  async assembleFile(
    uploadId: string,
    userId: string,
  ): Promise<{ tempFilePath: string; originalFilename: string }> {
    const session = this._getSession(uploadId, userId);
    const releaseLocks = await this._acquireSessionLocks([session]);
    try {
      const lockedSession = this._getSession(uploadId, userId);
      if (lockedSession !== session) throw notFound(`Upload session ${uploadId} not found`);
      this._requireUploading(lockedSession);
      this._assertAllChunksPresent(lockedSession);
      lockedSession.lifecycle = 'assembling';
      try {
        const assembled = await this._assembleClaimedSession(lockedSession);
        lockedSession.lifecycle = 'consumed';
        this._removeSession(lockedSession);
        return assembled;
      } catch (error) {
        lockedSession.lifecycle = 'uploading';
        throw error;
      }
    } finally {
      releaseLocks();
    }
  }

  private async _assembleClaimedSession(
    session: UploadSession,
  ): Promise<{ tempFilePath: string; originalFilename: string }> {
    const safeFilename = path.basename(session.filename.replaceAll('\\', '/'));
    const tempFilePath = path.join(os.tmpdir(), `upload_${session.uploadId}_${safeFilename}`);
    const outStream = fs.createWriteStream(tempFilePath);

    try {
      // Concatenate chunks in order
      for (let i = 0; i < session.totalChunks; i++) {
        const chunkPath = path.join(session.chunksDir, `chunk_${i}`);
        const chunkStream = fs.createReadStream(chunkPath);
        await pipeline(chunkStream, outStream, { end: false });
      }
      outStream.end();

      // Wait for the stream to finish
      await new Promise<void>((resolve, reject) => {
        outStream.on('finish', resolve);
        outStream.on('error', reject);
      });

      // Verify total size
      const stat = fs.statSync(tempFilePath);
      if (stat.size !== session.totalSize) {
        throw validationError(
          `Assembled file size ${stat.size} does not match declared totalSize ${session.totalSize}`,
        );
      }

      logger.info({ uploadId: session.uploadId, tempFilePath, size: stat.size }, 'File assembled');

      return { tempFilePath, originalFilename: session.filename };
    } catch (error) {
      outStream.destroy();
      await fs.promises.rm(tempFilePath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async assembleFiles(
    uploadIds: string[],
    userId: string,
  ): Promise<Array<{ tempFilePath: string; originalFilename: string }>> {
    const sessions = uploadIds.map((uploadId) => this._getSession(uploadId, userId));
    const releaseLocks = await this._acquireSessionLocks(sessions);
    const assembled: Array<{ tempFilePath: string; originalFilename: string }> = [];
    try {
      // Validate every member under lock before atomically claiming the group.
      for (let index = 0; index < sessions.length; index += 1) {
        const session = sessions[index];
        if (this._getSession(uploadIds[index], userId) !== session) {
          throw notFound(`Upload session ${uploadIds[index]} not found`);
        }
        this._requireUploading(session);
        this._assertAllChunksPresent(session);
      }
      for (const session of sessions) session.lifecycle = 'assembling';

      for (const session of sessions) {
        assembled.push(await this._assembleClaimedSession(session));
      }
      for (const session of sessions) {
        session.lifecycle = 'consumed';
        this._removeSession(session);
      }
      return assembled;
    } catch (error) {
      await Promise.all(
        assembled.map(({ tempFilePath }) => fs.promises.rm(tempFilePath, { force: true }).catch(() => {})),
      );
      for (const session of sessions) {
        if (this.sessions.get(session.uploadId) === session && session.lifecycle === 'assembling') {
          session.lifecycle = 'uploading';
        }
      }
      throw error;
    } finally {
      releaseLocks();
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // Clean up all active sessions
    for (const uploadId of this.sessions.keys()) {
      this._cleanupSession(uploadId);
    }
  }

  private _getSession(uploadId: string, userId: string): UploadSession {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw notFound(`Upload session ${uploadId} not found`);
    }
    if (session.userId !== userId) {
      throw notFound(`Upload session ${uploadId} not found`);
    }
    if (new Date() > session.expiresAt) {
      if (session.lockRequests === 0) this._cleanupSession(uploadId);
      throw validationError(`Upload session ${uploadId} has expired`);
    }
    return session;
  }

  private async _acquireSessionLocks(sessions: UploadSession[]): Promise<() => void> {
    const ordered = [...new Set(sessions)].sort((a, b) => a.uploadId.localeCompare(b.uploadId));
    const reservations = ordered.map((session) => {
      const previous = session.lockTail;
      let releaseTurn!: () => void;
      const turn = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      session.lockRequests += 1;
      session.lockTail = previous.then(() => turn);
      return { session, previous, releaseTurn };
    });

    for (const reservation of reservations) {
      await reservation.previous;
      reservation.session.lockActive = true;
    }

    return () => {
      for (const reservation of [...reservations].reverse()) {
        reservation.session.lockActive = false;
        reservation.session.lockRequests -= 1;
        reservation.releaseTurn();
      }
    };
  }

  private _requireUploading(session: UploadSession): void {
    if (session.lifecycle !== 'uploading') {
      throw notFound(`Upload session ${session.uploadId} not found`);
    }
  }

  private _assertAllChunksPresent(session: UploadSession): void {
    for (let index = 0; index < session.totalChunks; index += 1) {
      if (!session.receivedChunks.has(index)) {
        throw validationError(`Missing chunk ${index} of ${session.totalChunks}`);
      }
    }
  }

  private _cleanupSession(uploadId: string): void {
    const session = this.sessions.get(uploadId);
    if (!session) return;

    this._removeSession(session);
  }

  private _removeSession(session: UploadSession): void {
    if (this.sessions.get(session.uploadId) !== session) return;

    try {
      fs.rmSync(session.chunksDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ uploadId: session.uploadId, err }, 'Failed to clean up chunks directory');
    }
    this.sessions.delete(session.uploadId);
  }

  private _cleanupExpired(): void {
    const now = new Date();
    let cleaned = 0;
    for (const [uploadId, session] of this.sessions.entries()) {
      if (now > session.expiresAt && session.lockRequests === 0 && !session.lockActive) {
        this._cleanupSession(uploadId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up expired upload sessions');
    }
  }
}

export const uploadService = new UploadService();
