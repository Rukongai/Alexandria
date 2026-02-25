import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { createLogger } from '../utils/logger.js';
import { validationError, notFound } from '../utils/errors.js';

const logger = createLogger('UploadService');

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

interface UploadSession {
  uploadId: string;
  filename: string;
  totalSize: number;
  totalChunks: number;
  receivedChunks: Set<number>;
  chunksDir: string;
  userId: string;
  libraryId: string;
  metadata?: Record<string, string>;
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
    libraryId: string,
    metadata?: Record<string, string>,
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
      chunksDir,
      userId,
      libraryId,
      metadata,
      createdAt: now,
      expiresAt,
    };

    this.sessions.set(uploadId, session);
    logger.info({ uploadId, filename, totalSize, totalChunks, libraryId }, 'Upload session created');

    return { uploadId, expiresAt: expiresAt.toISOString() };
  }

  getSessionInfo(uploadId: string, userId: string): { libraryId: string; metadata?: Record<string, string> } {
    const session = this._getSession(uploadId, userId);
    return { libraryId: session.libraryId, metadata: session.metadata };
  }

  async receiveChunk(
    uploadId: string,
    chunkIndex: number,
    dataStream: Readable,
    userId: string,
  ): Promise<{ received: number }> {
    const session = this._getSession(uploadId, userId);

    if (chunkIndex >= session.totalChunks) {
      throw validationError(`Chunk index ${chunkIndex} exceeds totalChunks ${session.totalChunks}`);
    }

    const chunkPath = path.join(session.chunksDir, `chunk_${chunkIndex}`);
    const writeStream = fs.createWriteStream(chunkPath);
    await pipeline(dataStream, writeStream);

    const stat = fs.statSync(chunkPath);
    session.receivedChunks.add(chunkIndex);

    logger.debug(
      { uploadId, chunkIndex, bytes: stat.size, received: session.receivedChunks.size, total: session.totalChunks },
      'Chunk received',
    );

    return { received: stat.size };
  }

  async assembleFile(
    uploadId: string,
    userId: string,
  ): Promise<{ tempFilePath: string; originalFilename: string }> {
    const session = this._getSession(uploadId, userId);

    // Verify all chunks are present
    for (let i = 0; i < session.totalChunks; i++) {
      if (!session.receivedChunks.has(i)) {
        throw validationError(`Missing chunk ${i} of ${session.totalChunks}`);
      }
    }

    const tempFilePath = path.join(os.tmpdir(), `upload_${uploadId}_${session.filename}`);
    const outStream = fs.createWriteStream(tempFilePath);

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
      fs.unlinkSync(tempFilePath);
      throw validationError(
        `Assembled file size ${stat.size} does not match declared totalSize ${session.totalSize}`,
      );
    }

    // Clean up chunks directory
    this._cleanupSession(uploadId);

    logger.info({ uploadId, tempFilePath, size: stat.size }, 'File assembled');

    return { tempFilePath, originalFilename: session.filename };
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
      this._cleanupSession(uploadId);
      throw validationError(`Upload session ${uploadId} has expired`);
    }
    return session;
  }

  private _cleanupSession(uploadId: string): void {
    const session = this.sessions.get(uploadId);
    if (!session) return;

    try {
      fs.rmSync(session.chunksDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ uploadId, err }, 'Failed to clean up chunks directory');
    }
    this.sessions.delete(uploadId);
  }

  private _cleanupExpired(): void {
    const now = new Date();
    let cleaned = 0;
    for (const [uploadId, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
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
