import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  config,
  resolveS3ThumbnailCachePath,
  type AppConfig,
} from '../config/index.js';
import { storageError } from '../utils/errors.js';
import { EtagCalculator } from '../utils/etag.js';
import { S3StorageService } from './s3-storage.service.js';
import { S3ThumbnailCacheService } from './s3-thumbnail-cache.service.js';
import { observeThrottling } from './s3-throttling.js';
import { validateStorageKey } from './storage-key.js';

/** Concurrent parts `@aws-sdk/lib-storage` keeps in flight per upload (its default). */
const S3_MULTIPART_QUEUE_SIZE = 4;
/** Spare sockets for reads, HEADs, and deletes running alongside uploads. */
const S3_SOCKET_HEADROOM = 16;
/**
 * Retry strategy for the S3 client.
 *
 * `adaptive` is `standard` plus a client-side rate limiter that reacts to
 * throttled responses by slowing the whole client down. Object stores that
 * meter request rate — MEGA S4 serves 40-50 upload requests per second per
 * account — ask clients to reduce concurrency on `SlowDown` rather than simply
 * retry, and this is the SDK's implementation of that.
 */
const S3_RETRY_MODE = 'adaptive';
/**
 * Attempts per request, up from the SDK's default of 3.
 *
 * Under a rate limit a rejection is an expected, self-resolving condition
 * rather than a fault, and the request should outlive a few of them. Throttled
 * retries back off from 500 ms and are capped at 20 s by the SDK, so the extra
 * attempts cost waiting, not hammering.
 */
const S3_MAX_ATTEMPTS = 6;

export type StorageData = Buffer | Readable;
export type StorageProgressCallback = (transferredBytes: number) => void;

/**
 * What a backend can tell the caller about a completed write.
 *
 * `etag` lets a caller confirm the stored bytes match what it sent without
 * downloading the object again; see `utils/etag.ts`. Backends with no such
 * concept (the local filesystem) leave both fields undefined, and callers must
 * treat that as "verification unavailable" rather than "verification failed".
 */
export interface StoreResult {
  etag?: string;
  /** Part size used for the upload, needed to reproduce a multipart ETag. */
  partSize?: number;
}

export interface IStorageService {
  readonly kind: 'local' | 's3';
  /**
   * Part size this backend uploads with, when it has one. Needed up front to
   * reproduce a multipart ETag while the bytes stream past; backends without a
   * multipart concept leave it undefined.
   */
  readonly uploadPartSize?: number;
  store(
    filePath: string,
    data: StorageData,
    onProgress?: StorageProgressCallback,
  ): Promise<StoreResult>;
  retrieve(filePath: string): Promise<Buffer>;
  retrieveStream(filePath: string): Promise<Readable>;
  copy(sourcePath: string, destinationPath: string): Promise<void>;
  delete(filePath: string): Promise<void>;
  /**
   * Delete many objects, reporting per-object failures rather than throwing.
   *
   * Callers deleting a model's files are cleaning up after the database row is
   * already gone, so one unreachable object must not abandon the rest. The
   * returned failures are for logging; an empty array means everything was
   * removed or was already absent.
   */
  deleteMany(filePaths: string[]): Promise<StorageDeleteFailure[]>;
  exists(filePath: string): Promise<boolean>;
}

export interface StorageDeleteFailure {
  filePath: string;
  reason: string;
}

export class LocalStorageService implements IStorageService {
  readonly kind = 'local' as const;

  private readonly root: string;

  constructor(storagePath: string = config.storagePath) {
    this.root = storagePath;
  }

  getStorageRoot(): string {
    return path.resolve(this.root);
  }

  resolveStoragePath(filePath: string): string {
    return this.resolve(filePath);
  }

  async store(
    filePath: string,
    data: StorageData,
    onProgress?: StorageProgressCallback,
  ): Promise<StoreResult> {
    const absolute = this.resolve(filePath);
    const dir = path.dirname(absolute);

    try {
      await fsPromises.mkdir(dir, { recursive: true });

      if (Buffer.isBuffer(data)) {
        await fsPromises.writeFile(absolute, data);
        reportStorageProgress(onProgress, data.length);
      } else {
        const writeStream = fs.createWriteStream(absolute);
        writeStream.on('drain', () => {
          reportStorageProgress(onProgress, writeStream.bytesWritten);
        });
        await pipeline(data, writeStream);
        reportStorageProgress(onProgress, writeStream.bytesWritten);
      }

      // The filesystem has no ETag; local writes are verified by the OS.
      return {};
    } catch (error) {
      throw storageError(`Failed to store file at ${filePath}: ${errorMessage(error)}`);
    }
  }

  async retrieve(filePath: string): Promise<Buffer> {
    const absolute = this.resolve(filePath);
    try {
      return await fsPromises.readFile(absolute);
    } catch (error) {
      throw storageError(`Failed to retrieve file at ${filePath}: ${errorMessage(error)}`);
    }
  }

  async retrieveStream(filePath: string): Promise<Readable> {
    const absolute = this.resolve(filePath);
    try {
      await fsPromises.access(absolute);
      return fs.createReadStream(absolute);
    } catch (error) {
      throw storageError(`Failed to retrieve file at ${filePath}: ${errorMessage(error)}`);
    }
  }

  async copy(sourcePath: string, destinationPath: string): Promise<void> {
    const source = this.resolve(sourcePath);
    const destination = this.resolve(destinationPath);

    try {
      await fsPromises.mkdir(path.dirname(destination), { recursive: true });
      await fsPromises.copyFile(source, destination);
    } catch (error) {
      throw storageError(
        `Failed to copy file from ${sourcePath} to ${destinationPath}: ${errorMessage(error)}`,
      );
    }
  }

  async delete(filePath: string): Promise<void> {
    const absolute = this.resolve(filePath);
    try {
      await fsPromises.unlink(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw storageError(`Failed to delete file at ${filePath}: ${errorMessage(error)}`);
    }
  }

  async deleteMany(filePaths: string[]): Promise<StorageDeleteFailure[]> {
    // The filesystem has no batch unlink, so this is the same work the caller
    // would do itself; it exists so callers need only one code path.
    const failures: StorageDeleteFailure[] = [];
    for (const filePath of filePaths) {
      try {
        await this.delete(filePath);
      } catch (error) {
        failures.push({ filePath, reason: errorMessage(error) });
      }
    }
    return failures;
  }

  async exists(filePath: string): Promise<boolean> {
    const absolute = this.resolve(filePath);
    try {
      await fsPromises.access(absolute);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw storageError(`Failed to check file at ${filePath}: ${errorMessage(error)}`);
    }
  }

  private resolve(filePath: string): string {
    validateStorageKey(filePath);
    return path.resolve(this.root, ...filePath.split('/'));
  }
}

export { LocalStorageService as StorageService };

export function isLocalStorageService(
  storage: IStorageService,
): storage is LocalStorageService {
  return storage.kind === 'local';
}

/**
 * How many files to upload at once for a given backend.
 *
 * Only remote backends benefit: their cost is dominated by per-request round
 * trips. Local writes stay sequential so filesystem imports keep their existing
 * ordering and disk access pattern.
 */
export function uploadConcurrencyFor(
  storage: IStorageService,
  appConfig: AppConfig = config,
): number {
  return storage.kind === 's3' ? appConfig.storageUploadConcurrency : 1;
}

export interface VerifiedStoreOptions {
  /** SHA-256 the source bytes are expected to hash to. */
  expectedSha256?: string;
  expectedSize?: number;
  onProgress?: StorageProgressCallback;
}

export interface VerifiedStoreResult extends StoreResult {
  /** Whether the backend returned an ETag that could be checked. */
  etagVerified: boolean;
  sha256: string;
  sizeBytes: number;
}

/**
 * Store a file and verify it landed intact, without reading it back.
 *
 * The source is hashed as it streams to the backend, producing two independent
 * checks for the price of one pass over bytes already in flight:
 *
 *   - SHA-256 over what was read, compared against the hash recorded when the
 *     file was scanned — catches a source that changed or read back wrong
 *   - the S3 ETag the bytes should produce, compared against what the provider
 *     reports — catches truncation or corruption in transit
 *
 * This replaces downloading each object again to hash it, which doubled the
 * bytes crossing the wire and dominated import time on a remote backend.
 *
 * `createSource` is a factory rather than a stream so the caller cannot
 * accidentally supply one that has already been consumed.
 */
export async function storeVerified(
  storage: IStorageService,
  storagePath: string,
  createSource: () => Readable,
  options: VerifiedStoreOptions = {},
): Promise<VerifiedStoreResult> {
  const partSize = storage.uploadPartSize;
  const etagCalculator = partSize === undefined ? undefined : new EtagCalculator(partSize);
  const sha256 = createHash('sha256');
  let sizeBytes = 0;

  const source = createSource();
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        sha256.update(chunk);
        sizeBytes += chunk.length;
        etagCalculator?.update(chunk);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  // `pipe` does not forward source failures, which would otherwise leave the
  // upload waiting on a stream that will never end.
  source.on('error', (error) => hashing.destroy(error));
  source.pipe(hashing);

  const result = await storage.store(storagePath, hashing, options.onProgress);
  const digest = sha256.digest('hex');

  if (options.expectedSize !== undefined && sizeBytes !== options.expectedSize) {
    throw storageError(
      `Stored object has unexpected size: ${storagePath} ` +
        `(expected ${options.expectedSize} bytes, read ${sizeBytes})`,
    );
  }
  if (options.expectedSha256 !== undefined && digest !== options.expectedSha256) {
    throw storageError(`Stored object failed SHA-256 verification: ${storagePath}`);
  }

  // A backend with no ETag concept (the local filesystem) reports nothing to
  // compare, which is not the same as reporting a mismatch.
  const comparablePartSize = result.partSize === undefined || result.partSize === partSize;
  const etagVerified =
    etagCalculator !== undefined && result.etag !== undefined && comparablePartSize;

  if (etagVerified && !etagCalculator.matches(result.etag)) {
    throw storageError(
      `Stored object failed ETag verification: ${storagePath} (reported ${result.etag})`,
    );
  }

  return { ...result, etagVerified, sha256: digest, sizeBytes };
}

export function createStorageService(appConfig: AppConfig = config): IStorageService {
  if (appConfig.storageBackend === 'local') {
    return new LocalStorageService(appConfig.storagePath);
  }

  if (!appConfig.s3.bucket) {
    throw storageError('S3_BUCKET is required when STORAGE_BACKEND=s3');
  }

  // Files are uploaded concurrently, and each multipart upload itself keeps
  // several parts in flight, so the socket pool has to cover the product of the
  // two. The SDK's default of 50 would otherwise silently become the real
  // concurrency ceiling once fan-out is enabled.
  const maxSockets =
    appConfig.storageUploadConcurrency * S3_MULTIPART_QUEUE_SIZE + S3_SOCKET_HEADROOM;

  const client = new S3Client({
    endpoint: appConfig.s3.endpoint,
    region: appConfig.s3.region,
    forcePathStyle: appConfig.s3.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    // Adaptive adds a client-side rate limiter on top of the standard backoff:
    // observing a throttled response slows every subsequent request, not just
    // the retry of the one that was rejected. Standard mode retries the loser
    // and lets the rest of the fan-out keep arriving at the same rate, which is
    // how a burst of small files sustains throttling instead of easing out of
    // it. Providers that meter request rate ask for exactly this behaviour.
    retryMode: S3_RETRY_MODE,
    maxAttempts: S3_MAX_ATTEMPTS,
    requestHandler: new NodeHttpHandler({
      httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets }),
      httpAgent: new HttpAgent({ keepAlive: true, maxSockets }),
    }),
  });

  // The adaptive rate limiter reacts to throttling silently. Without this the
  // only visible symptom is a slow import, with nothing to distinguish "the
  // provider is metering us" from "the network is slow".
  observeThrottling(client);

  const s3Storage = new S3StorageService({
    client,
    bucket: appConfig.s3.bucket,
    prefix: appConfig.s3.prefix,
  });

  if (appConfig.s3ThumbnailCacheMaxBytes > 0) {
    return new S3ThumbnailCacheService({
      storage: s3Storage,
      cacheRoot: resolveS3ThumbnailCachePath(
        appConfig.storagePath,
        appConfig.s3ThumbnailCachePath,
      ),
      maxBytes: appConfig.s3ThumbnailCacheMaxBytes,
    });
  }
  return s3Storage;
}

export const storageService = createStorageService();

export async function validateStorageBackend(
  storage: IStorageService = storageService,
): Promise<void> {
  if (storage instanceof S3StorageService || storage instanceof S3ThumbnailCacheService) {
    await storage.validateBucketAccess();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportStorageProgress(
  onProgress: StorageProgressCallback | undefined,
  transferredBytes: number,
): void {
  try {
    onProgress?.(transferredBytes);
  } catch {
    // Progress is observational and must never turn a successful write into a failure.
  }
}
