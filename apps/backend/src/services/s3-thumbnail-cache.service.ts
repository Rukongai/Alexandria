import { createHash, randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { storageError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { validateStorageKey } from './storage-key.js';
import type {
  IStorageService,
  StorageData,
  StorageDeleteFailure,
  StorageProgressCallback,
  StoreResult,
} from './storage.service.js';

interface S3AuthoritativeStorage extends IStorageService {
  readonly kind: 's3';
  validateBucketAccess?: () => Promise<void>;
}

export interface S3ThumbnailCacheServiceOptions {
  storage: S3AuthoritativeStorage;
  cacheRoot: string;
  maxBytes: number;
}

interface CacheEntry {
  absolutePath: string;
  mtimeMs: number;
  size: number;
}

interface CacheMutation {
  cachePath: string;
  key: string;
  invalidation: Promise<CacheInvalidation>;
}

interface CacheInvalidation {
  physicallyRemoved: boolean;
  safe: boolean;
}

const logger = createLogger('S3ThumbnailCacheService');
const INVALIDATION_DIRECTORY = '.invalidated';

/**
 * Persistent local thumbnail cache in front of an authoritative S3 backend.
 *
 * Only keys beneath `thumbnails/` participate. Cache failures fall back to S3,
 * except that a thumbnail mutation is rejected if neither its stale bytes nor
 * a durable invalidation marker can be written safely before changing S3.
 */
export class S3ThumbnailCacheService implements IStorageService {
  readonly kind = 's3' as const;
  readonly uploadPartSize: number | undefined;

  private readonly storage: S3AuthoritativeStorage;
  private readonly cacheRoot: string;
  private readonly maxBytes: number;
  private readonly loads = new Map<string, Promise<Buffer>>();
  private readonly activeLoads = new Map<string, number>();
  private readonly revisions = new Map<string, number>();
  private readonly bypassedKeys = new Set<string>();
  private readonly invalidatedKeyHashes = new Set<string>();
  /** Oldest entry first; deleting and setting a key moves it to the MRU end. */
  private readonly cacheEntries = new Map<string, number>();
  private cacheBytes = 0;
  private nextRevision = 1;
  private maintenance = Promise.resolve();
  private prepared = false;
  private unavailable = false;
  private preparing: Promise<boolean> | undefined;

  constructor(options: S3ThumbnailCacheServiceOptions) {
    if (options.storage.kind !== 's3') {
      throw storageError('The S3 thumbnail cache can only decorate S3 storage');
    }
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
      throw storageError('The S3 thumbnail cache size must be a positive integer');
    }

    this.storage = options.storage;
    this.cacheRoot = path.resolve(options.cacheRoot);
    this.maxBytes = options.maxBytes;
    this.uploadPartSize = options.storage.uploadPartSize;
  }

  async store(
    filePath: string,
    data: StorageData,
    onProgress?: StorageProgressCallback,
  ): Promise<StoreResult> {
    const mutation = this.beginMutation(filePath);
    if (mutation) await this.requireSafeInvalidation(mutation);
    try {
      const result = await this.storage.store(filePath, data, onProgress);
      if (!mutation) return result;

      this.commitMutation(mutation.key);
      if (Buffer.isBuffer(data)) {
        if (
          await this.writeCache(mutation.cachePath, data)
          && await this.clearDurableInvalidation(mutation.key)
        ) {
          this.bypassedKeys.delete(mutation.key);
        }
      } else if (
        (await mutation.invalidation).physicallyRemoved
        && await this.clearDurableInvalidation(mutation.key)
      ) {
        this.bypassedKeys.delete(mutation.key);
      }
      this.releaseRevisionIfIdle(mutation.key);
      return result;
    } catch (error) {
      await this.finishFailedMutation(mutation);
      throw error;
    }
  }

  async retrieve(filePath: string): Promise<Buffer> {
    const cachePath = this.cachePathFor(filePath);
    if (!cachePath) return this.storage.retrieve(filePath);

    const normalizedKey = validateStorageKey(filePath);
    const existing = this.loads.get(normalizedKey);
    if (existing) return existing;

    const revision = this.revisions.get(normalizedKey) ?? 0;
    this.activeLoads.set(normalizedKey, (this.activeLoads.get(normalizedKey) ?? 0) + 1);
    const load = this.loadThumbnail(filePath, cachePath, normalizedKey, revision).finally(() => {
      if (this.loads.get(normalizedKey) === load) this.loads.delete(normalizedKey);
      const active = (this.activeLoads.get(normalizedKey) ?? 1) - 1;
      if (active > 0) this.activeLoads.set(normalizedKey, active);
      else this.activeLoads.delete(normalizedKey);
      this.releaseRevisionIfIdle(normalizedKey);
    });
    this.loads.set(normalizedKey, load);
    return load;
  }

  async retrieveStream(filePath: string): Promise<Readable> {
    const cachePath = this.cachePathFor(filePath);
    if (!cachePath) return this.storage.retrieveStream(filePath);
    return Readable.from([await this.retrieve(filePath)]);
  }

  async copy(sourcePath: string, destinationPath: string): Promise<void> {
    const mutation = this.beginMutation(destinationPath);
    if (mutation) await this.requireSafeInvalidation(mutation);
    try {
      await this.storage.copy(sourcePath, destinationPath);
      if (mutation) {
        this.commitMutation(mutation.key);
        if (
          (await mutation.invalidation).physicallyRemoved
          && await this.clearDurableInvalidation(mutation.key)
        ) {
          this.bypassedKeys.delete(mutation.key);
        }
        this.releaseRevisionIfIdle(mutation.key);
      }
    } catch (error) {
      await this.finishFailedMutation(mutation);
      throw error;
    }
  }

  async delete(filePath: string): Promise<void> {
    const mutation = this.beginMutation(filePath);
    if (mutation) await this.requireSafeInvalidation(mutation);
    try {
      await this.storage.delete(filePath);
      if (mutation) {
        this.commitMutation(mutation.key);
        if (
          (await mutation.invalidation).physicallyRemoved
          && await this.clearDurableInvalidation(mutation.key)
        ) {
          this.bypassedKeys.delete(mutation.key);
        }
        this.releaseRevisionIfIdle(mutation.key);
      }
    } catch (error) {
      await this.finishFailedMutation(mutation);
      throw error;
    }
  }

  async deleteMany(filePaths: string[]): Promise<StorageDeleteFailure[]> {
    const mutations = filePaths.map((filePath) => this.beginMutation(filePath));
    const invalidations = await Promise.all(
      mutations.map((mutation) => mutation?.invalidation),
    );
    const unsafeIndex = invalidations.findIndex((invalidation) => invalidation?.safe === false);
    if (unsafeIndex !== -1) {
      await Promise.all(mutations.map((mutation) => this.finishFailedMutation(mutation)));
      throw storageError(
        `Cannot safely mutate ${mutations[unsafeIndex]!.key} because its local thumbnail cache entry could not be invalidated`,
      );
    }
    let failures: StorageDeleteFailure[];
    try {
      failures = await this.storage.deleteMany(filePaths);
    } catch (error) {
      await Promise.all(mutations.map((mutation) => this.finishFailedMutation(mutation)));
      throw error;
    }

    const failedPaths = new Set(failures.map(({ filePath }) => filePath));
    await Promise.all(
      mutations.map(async (mutation, index) => {
        if (!mutation) return;
        if (!failedPaths.has(filePaths[index])) this.commitMutation(mutation.key);
        const invalidation = await mutation.invalidation;
        if (
          (invalidation.physicallyRemoved || failedPaths.has(filePaths[index]))
          && await this.clearDurableInvalidation(mutation.key)
        ) {
          this.bypassedKeys.delete(mutation.key);
        }
        this.releaseRevisionIfIdle(mutation.key);
      }),
    );
    return failures;
  }

  async exists(filePath: string): Promise<boolean> {
    return this.storage.exists(filePath);
  }

  async validateBucketAccess(): Promise<void> {
    await this.storage.validateBucketAccess?.();
  }

  private async loadThumbnail(
    filePath: string,
    cachePath: string,
    normalizedKey: string,
    revision: number,
  ): Promise<Buffer> {
    const cached = await this.readCache(cachePath, normalizedKey);
    if (cached) return cached;

    const authoritative = await this.storage.retrieve(filePath);
    if (
      (this.revisions.get(normalizedKey) ?? 0) === revision
      && !this.bypassedKeys.has(normalizedKey)
      && !this.isDurablyInvalidated(normalizedKey)
      && await this.writeCache(cachePath, authoritative)
    ) {
      this.bypassedKeys.delete(normalizedKey);
    }
    return authoritative;
  }

  private async readCache(cachePath: string, normalizedKey: string): Promise<Buffer | undefined> {
    if (this.bypassedKeys.has(normalizedKey) || this.isDurablyInvalidated(normalizedKey)) {
      return undefined;
    }
    if (!(await this.prepareCache())) return undefined;
    if (this.bypassedKeys.has(normalizedKey) || this.isDurablyInvalidated(normalizedKey)) {
      return undefined;
    }

    try {
      const data = await fsPromises.readFile(cachePath);
      if (this.bypassedKeys.has(normalizedKey) || this.isDurablyInvalidated(normalizedKey)) {
        return undefined;
      }

      // Recency bookkeeping must never put cache hits behind a global queue.
      void this.runMaintenance(async () => {
        if (this.bypassedKeys.has(normalizedKey) || this.isDurablyInvalidated(normalizedKey)) return;
        const now = new Date();
        await fsPromises.utimes(cachePath, now, now);
        this.touchEntry(cachePath, data.length);
      }).catch((error) => {
        logger.warn({ err: error, cachePath }, 'Failed to update thumbnail cache recency');
      });
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err: error, cachePath }, 'Failed to read thumbnail cache entry');
      }
      return undefined;
    }
  }

  private async writeCache(cachePath: string, data: Buffer): Promise<boolean> {
    if (!(await this.prepareCache())) return false;

    try {
      await this.runMaintenance(async () => {
        await fsPromises.mkdir(path.dirname(cachePath), { recursive: true });
        const temporaryPath = path.join(
          path.dirname(cachePath),
          `.${path.basename(cachePath)}.${randomUUID()}.tmp`,
        );

        try {
          await fsPromises.writeFile(temporaryPath, data);
          await fsPromises.rename(temporaryPath, cachePath);
          this.touchEntry(cachePath, data.length);
        } finally {
          await fsPromises.rm(temporaryPath, { force: true }).catch(() => {});
        }
        await this.evictToLimit();
      });
      return true;
    } catch (error) {
      logger.warn({ err: error, cachePath }, 'Failed to write thumbnail cache entry');
      return false;
    }
  }

  private async removeCache(cachePath: string): Promise<boolean> {
    if (!(await this.prepareCache())) {
      try {
        await fsPromises.unlink(cachePath);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return true;
        logger.warn(
          { err: error, cachePath },
          'Failed to verify thumbnail cache entry after cache initialization failed',
        );
        return false;
      }
    }
    try {
      await this.runMaintenance(async () => {
        await fsPromises.unlink(cachePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        this.forgetEntry(cachePath);
      });
      return true;
    } catch (error) {
      logger.warn({ err: error, cachePath }, 'Failed to invalidate thumbnail cache entry');
      return false;
    }
  }

  private async prepareCache(): Promise<boolean> {
    if (this.prepared) return true;
    if (this.unavailable) return false;
    if (this.preparing) return this.preparing;

    this.preparing = this.runMaintenance(async () => {
      await fsPromises.mkdir(this.cacheRoot, { recursive: true });
      const invalidationRoot = path.join(this.cacheRoot, INVALIDATION_DIRECTORY);
      await fsPromises.mkdir(invalidationRoot, { recursive: true });
      const invalidationMarkers = await fsPromises.readdir(invalidationRoot, {
        withFileTypes: true,
      });
      this.invalidatedKeyHashes.clear();
      for (const marker of invalidationMarkers) {
        if (!marker.isFile()) continue;
        this.invalidatedKeyHashes.add(marker.name);
        await this.recoverDurableInvalidation(path.join(invalidationRoot, marker.name), marker.name);
      }
      const entries = await this.listCacheEntries(this.cacheRoot);
      entries.sort((left, right) =>
        left.mtimeMs - right.mtimeMs || left.absolutePath.localeCompare(right.absolutePath),
      );
      this.cacheEntries.clear();
      this.cacheBytes = 0;
      for (const entry of entries) this.touchEntry(entry.absolutePath, entry.size);
      await this.evictToLimit();
      this.prepared = true;
      return true;
    })
      .catch((error) => {
        this.cacheEntries.clear();
        this.cacheBytes = 0;
        this.unavailable = true;
        logger.warn({ err: error, cacheRoot: this.cacheRoot }, 'Failed to initialize thumbnail cache');
        return false;
      })
      .finally(() => {
        this.preparing = undefined;
      });
    return this.preparing;
  }

  private async evictToLimit(): Promise<void> {
    if (this.cacheBytes <= this.maxBytes) return;

    for (const [absolutePath] of [...this.cacheEntries]) {
      if (this.cacheBytes <= this.maxBytes) break;
      try {
        await fsPromises.unlink(absolutePath);
        this.forgetEntry(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.forgetEntry(absolutePath);
        } else {
          logger.warn({ err: error, cachePath: absolutePath }, 'Failed to evict thumbnail cache entry');
        }
      }
    }
  }

  private async listCacheEntries(directory: string): Promise<CacheEntry[]> {
    const entries: CacheEntry[] = [];
    const children = await fsPromises.readdir(directory, { withFileTypes: true });

    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      if (child.isDirectory()) {
        if (directory === this.cacheRoot && child.name === INVALIDATION_DIRECTORY) continue;
        entries.push(...(await this.listCacheEntries(absolutePath)));
      } else if (child.isFile()) {
        const stats = await fsPromises.stat(absolutePath);
        entries.push({ absolutePath, mtimeMs: stats.mtimeMs, size: stats.size });
      }
    }
    return entries;
  }

  private cachePathFor(filePath: string): string | undefined {
    let normalized: string;
    try {
      normalized = validateStorageKey(filePath);
    } catch {
      return undefined;
    }

    const prefix = 'thumbnails/';
    if (!normalized.startsWith(prefix) || normalized.length === prefix.length) return undefined;
    return path.resolve(this.cacheRoot, ...normalized.slice(prefix.length).split('/'));
  }

  private beginMutation(filePath: string): CacheMutation | undefined {
    const cachePath = this.cachePathFor(filePath);
    if (!cachePath) return undefined;
    const key = validateStorageKey(filePath);
    this.bumpRevision(key);
    this.bypassedKeys.add(key);
    return { cachePath, key, invalidation: this.invalidateCache(cachePath, key) };
  }

  private commitMutation(key: string): void {
    this.bumpRevision(key);
    this.bypassedKeys.add(key);
  }

  private async finishFailedMutation(mutation: CacheMutation | undefined): Promise<void> {
    if (!mutation) return;
    const invalidation = await mutation.invalidation;
    if (!invalidation.safe || await this.clearDurableInvalidation(mutation.key)) {
      this.bypassedKeys.delete(mutation.key);
    }
    this.releaseRevisionIfIdle(mutation.key);
  }

  private async invalidateCache(cachePath: string, key: string): Promise<CacheInvalidation> {
    if (await this.removeCache(cachePath)) return { physicallyRemoved: true, safe: true };

    const keyHash = this.keyHash(key);
    const markerPath = path.join(this.cacheRoot, INVALIDATION_DIRECTORY, keyHash);
    try {
      await fsPromises.writeFile(markerPath, key, { flag: 'wx' }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
      this.invalidatedKeyHashes.add(keyHash);
      return { physicallyRemoved: false, safe: true };
    } catch (error) {
      logger.error(
        { err: error, cachePath, markerPath },
        'Failed to durably invalidate thumbnail cache entry',
      );
      return { physicallyRemoved: false, safe: false };
    }
  }

  private async requireSafeInvalidation(mutation: CacheMutation): Promise<void> {
    if ((await mutation.invalidation).safe) return;
    this.bypassedKeys.delete(mutation.key);
    this.releaseRevisionIfIdle(mutation.key);
    throw storageError(
      `Cannot safely mutate ${mutation.key} because its local thumbnail cache entry could not be invalidated`,
    );
  }

  private async clearDurableInvalidation(key: string): Promise<boolean> {
    const keyHash = this.keyHash(key);
    try {
      await fsPromises.unlink(path.join(this.cacheRoot, INVALIDATION_DIRECTORY, keyHash)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
      this.invalidatedKeyHashes.delete(keyHash);
      return true;
    } catch (error) {
      logger.warn({ err: error, key }, 'Failed to clear thumbnail cache invalidation marker');
      return false;
    }
  }

  private async recoverDurableInvalidation(markerPath: string, expectedHash: string): Promise<void> {
    try {
      const key = await fsPromises.readFile(markerPath, 'utf8');
      if (this.keyHash(validateStorageKey(key)) !== expectedHash) return;
      const cachePath = this.cachePathFor(key);
      if (!cachePath) return;
      await fsPromises.unlink(cachePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await fsPromises.unlink(markerPath);
      this.invalidatedKeyHashes.delete(expectedHash);
    } catch (error) {
      logger.warn(
        { err: error, markerPath },
        'Thumbnail cache invalidation marker remains active',
      );
    }
  }

  private isDurablyInvalidated(key: string): boolean {
    return this.invalidatedKeyHashes.has(this.keyHash(key));
  }

  private keyHash(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  private bumpRevision(key: string): void {
    this.revisions.set(key, this.nextRevision);
    this.nextRevision += 1;
    this.loads.delete(key);
  }

  private releaseRevisionIfIdle(key: string): void {
    if (!this.activeLoads.has(key)) this.revisions.delete(key);
  }

  private touchEntry(cachePath: string, size: number): void {
    const existingSize = this.cacheEntries.get(cachePath);
    if (existingSize !== undefined) {
      this.cacheBytes -= existingSize;
      this.cacheEntries.delete(cachePath);
    }
    this.cacheEntries.set(cachePath, size);
    this.cacheBytes += size;
  }

  private forgetEntry(cachePath: string): void {
    const size = this.cacheEntries.get(cachePath);
    if (size === undefined) return;
    this.cacheEntries.delete(cachePath);
    this.cacheBytes -= size;
  }

  private runMaintenance<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.maintenance.then(operation, operation);
    this.maintenance = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
