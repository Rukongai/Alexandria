import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3ThumbnailCacheService } from './s3-thumbnail-cache.service.js';
import type {
  IStorageService,
  StorageData,
  StorageDeleteFailure,
  StorageProgressCallback,
  StoreResult,
} from './storage.service.js';

async function toBuffer(data: StorageData): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  const chunks: Buffer[] = [];
  for await (const chunk of data) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

class FakeS3Storage implements IStorageService {
  readonly kind = 's3' as const;
  readonly uploadPartSize = 8 * 1024 * 1024;
  readonly objects = new Map<string, Buffer>();
  readonly failedDeletes = new Set<string>();

  async store(
    filePath: string,
    data: StorageData,
    onProgress?: StorageProgressCallback,
  ): Promise<StoreResult> {
    const buffer = await toBuffer(data);
    this.objects.set(filePath, buffer);
    onProgress?.(buffer.length);
    return { etag: 'etag', partSize: this.uploadPartSize };
  }

  async retrieve(filePath: string): Promise<Buffer> {
    const data = this.objects.get(filePath);
    if (!data) throw new Error(`missing ${filePath}`);
    return Buffer.from(data);
  }

  async retrieveStream(filePath: string): Promise<Readable> {
    return Readable.from([await this.retrieve(filePath)]);
  }

  async copy(sourcePath: string, destinationPath: string): Promise<void> {
    this.objects.set(destinationPath, await this.retrieve(sourcePath));
  }

  async delete(filePath: string): Promise<void> {
    this.objects.delete(filePath);
  }

  async deleteMany(filePaths: string[]): Promise<StorageDeleteFailure[]> {
    const failures: StorageDeleteFailure[] = [];
    for (const filePath of filePaths) {
      if (this.failedDeletes.has(filePath)) {
        failures.push({ filePath, reason: 'locked' });
      } else {
        this.objects.delete(filePath);
      }
    }
    return failures;
  }

  async exists(filePath: string): Promise<boolean> {
    return this.objects.has(filePath);
  }
}

const temporaryDirectories: string[] = [];
let cacheRoot: string;
let authoritative: FakeS3Storage;
let service: S3ThumbnailCacheService;

beforeEach(async () => {
  cacheRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'alexandria-thumb-cache-'));
  temporaryDirectories.push(cacheRoot);
  authoritative = new FakeS3Storage();
  service = new S3ThumbnailCacheService({
    storage: authoritative,
    cacheRoot,
    maxBytes: 1024,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fsPromises.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('S3ThumbnailCacheService', () => {
  it('reads through once and serves later buffered and streaming reads from local cache', async () => {
    const key = 'thumbnails/model-1/preview.webp';
    authoritative.objects.set(key, Buffer.from('remote-preview'));
    const retrieve = vi.spyOn(authoritative, 'retrieve');

    await expect(service.retrieve(key)).resolves.toEqual(Buffer.from('remote-preview'));
    await expect(readStream(await service.retrieveStream(key))).resolves.toEqual(
      Buffer.from('remote-preview'),
    );

    expect(retrieve).toHaveBeenCalledTimes(1);
    await expect(fsPromises.readFile(path.join(cacheRoot, 'model-1/preview.webp'))).resolves.toEqual(
      Buffer.from('remote-preview'),
    );
  });

  it('coalesces concurrent misses across buffered and streaming retrieval', async () => {
    const key = 'thumbnails/model-1/preview.webp';
    authoritative.objects.set(key, Buffer.from('one-download'));
    const retrieve = vi.spyOn(authoritative, 'retrieve').mockImplementation(async (filePath) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Buffer.from(authoritative.objects.get(filePath)!);
    });

    const buffered = service.retrieve(key);
    const streamed = service.retrieveStream(key).then(readStream);

    await expect(Promise.all([buffered, streamed])).resolves.toEqual([
      Buffer.from('one-download'),
      Buffer.from('one-download'),
    ]);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('writes Buffer thumbnails through after S3 succeeds and ignores non-thumbnail keys', async () => {
    const thumbnailKey = 'thumbnails/model-1/preview.webp';
    const modelKey = 'models/model-1/model.stl';
    const store = vi.spyOn(authoritative, 'store');

    await service.store(thumbnailKey, Buffer.from('thumbnail'));
    await service.store(modelKey, Buffer.from('model'));
    authoritative.objects.delete(thumbnailKey);

    await expect(service.retrieve(thumbnailKey)).resolves.toEqual(Buffer.from('thumbnail'));
    expect(store).toHaveBeenCalledTimes(2);
    await expect(fsPromises.stat(path.join(cacheRoot, 'models'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await fsPromises.readdir(path.join(cacheRoot, 'model-1'))).some(
      (name) => name.endsWith('.tmp'),
    )).toBe(false);
  });

  it('invalidates cache entries before single and batch deletes, including failed S3 deletes', async () => {
    const first = 'thumbnails/model-1/first.webp';
    const second = 'thumbnails/model-1/second.webp';
    await service.store(first, Buffer.from('first'));
    await service.store(second, Buffer.from('second'));

    await service.delete(first);
    authoritative.failedDeletes.add(second);
    await expect(service.deleteMany([second])).resolves.toEqual([
      { filePath: second, reason: 'locked' },
    ]);

    await expect(fsPromises.stat(path.join(cacheRoot, 'model-1/first.webp'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fsPromises.stat(path.join(cacheRoot, 'model-1/second.webp'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(service.retrieve(second)).resolves.toEqual(Buffer.from('second'));
  });

  it('invalidates a cached destination after an authoritative copy', async () => {
    const source = 'thumbnails/model-1/source.webp';
    const destination = 'thumbnails/model-1/destination.webp';
    authoritative.objects.set(source, Buffer.from('new-copy'));
    await service.store(destination, Buffer.from('old-destination'));

    await service.copy(source, destination);
    const retrieve = vi.spyOn(authoritative, 'retrieve');

    await expect(service.retrieve(destination)).resolves.toEqual(Buffer.from('new-copy'));
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith(destination);
  });

  it('updates LRU recency and evicts the oldest files to the byte limit', async () => {
    service = new S3ThumbnailCacheService({
      storage: authoritative,
      cacheRoot,
      maxBytes: 6,
    });
    const first = 'thumbnails/model-1/first.webp';
    const second = 'thumbnails/model-1/second.webp';
    const third = 'thumbnails/model-1/third.webp';
    await service.store(first, Buffer.from('111'));
    await service.store(second, Buffer.from('222'));

    const old = new Date('2000-01-01T00:00:00Z');
    const newer = new Date('2001-01-01T00:00:00Z');
    await fsPromises.utimes(path.join(cacheRoot, 'model-1/first.webp'), old, old);
    await fsPromises.utimes(path.join(cacheRoot, 'model-1/second.webp'), newer, newer);
    await service.retrieve(first); // first is now most recently used
    await service.store(third, Buffer.from('333'));

    const retrieve = vi.spyOn(authoritative, 'retrieve');
    await expect(service.retrieve(first)).resolves.toEqual(Buffer.from('111'));
    await expect(service.retrieve(second)).resolves.toEqual(Buffer.from('222'));
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith(second);

    const cachedFiles = await fsPromises.readdir(path.join(cacheRoot, 'model-1'));
    const sizes = await Promise.all(
      cachedFiles.map((name) => fsPromises.stat(path.join(cacheRoot, 'model-1', name))),
    );
    expect(sizes.reduce((total, stats) => total + stats.size, 0)).toBeLessThanOrEqual(6);
  });

  it('indexes the existing cache once instead of rescanning it on every write', async () => {
    await service.store('thumbnails/model-1/first.webp', Buffer.from('first'));
    const readdir = vi.spyOn(fsPromises, 'readdir');

    await service.store('thumbnails/model-1/second.webp', Buffer.from('second'));

    expect(readdir).not.toHaveBeenCalled();
  });

  it('does not let an in-flight old read overwrite a newer stored thumbnail', async () => {
    const key = 'thumbnails/model-1/preview.webp';
    authoritative.objects.set(key, Buffer.from('old'));
    let releaseRead: (() => void) | undefined;
    const readStarted = new Promise<void>((resolveStarted) => {
      vi.spyOn(authoritative, 'retrieve').mockImplementation(async (filePath) => {
        const captured = Buffer.from(authoritative.objects.get(filePath)!);
        resolveStarted();
        await new Promise<void>((resolve) => { releaseRead = resolve; });
        return captured;
      });
    });

    const oldRead = service.retrieve(key);
    await readStarted;
    await service.store(key, Buffer.from('new'));
    releaseRead?.();
    await expect(oldRead).resolves.toEqual(Buffer.from('old'));

    authoritative.objects.delete(key);
    await expect(service.retrieve(key)).resolves.toEqual(Buffer.from('new'));
  });

  it('durably bypasses stale disk bytes when invalidation and replacement both fail', async () => {
    const key = 'thumbnails/model-1/preview.webp';
    await service.store(key, Buffer.from('old'));
    const unlink = vi.spyOn(fsPromises, 'unlink').mockRejectedValue(
      Object.assign(new Error('read-only cache'), { code: 'EACCES' }),
    );
    const rename = vi.spyOn(fsPromises, 'rename').mockRejectedValue(
      Object.assign(new Error('read-only cache'), { code: 'EACCES' }),
    );

    await service.store(key, Buffer.from('new'));
    const retrieve = vi.spyOn(authoritative, 'retrieve');
    await expect(service.retrieve(key)).resolves.toEqual(Buffer.from('new'));
    expect(retrieve).toHaveBeenCalledWith(key);

    unlink.mockRestore();
    rename.mockRestore();

    service = new S3ThumbnailCacheService({
      storage: authoritative,
      cacheRoot,
      maxBytes: 1024,
    });
    await expect(service.retrieve(key)).resolves.toEqual(Buffer.from('new'));
    await expect(fsPromises.readFile(path.join(cacheRoot, 'model-1/preview.webp'))).resolves.toEqual(
      Buffer.from('new'),
    );
  });

  it('rejects a thumbnail mutation before S3 when no durable invalidation is possible', async () => {
    const key = 'thumbnails/model-1/preview.webp';
    await service.store(key, Buffer.from('old'));
    const unlink = vi.spyOn(fsPromises, 'unlink').mockRejectedValue(
      Object.assign(new Error('read-only cache'), { code: 'EACCES' }),
    );
    const writeFile = vi.spyOn(fsPromises, 'writeFile').mockRejectedValue(
      Object.assign(new Error('read-only cache'), { code: 'EACCES' }),
    );

    await expect(service.store(key, Buffer.from('new'))).rejects.toThrow(
      'local thumbnail cache entry could not be invalidated',
    );
    expect(authoritative.objects.get(key)).toEqual(Buffer.from('old'));

    unlink.mockRestore();
    writeFile.mockRestore();
  });

  it('removes the exact stale entry when cache indexing fails transiently', async () => {
    const key = 'thumbnails/model-1/preview.webp';
    const cachePath = path.join(cacheRoot, 'model-1/preview.webp');
    await fsPromises.mkdir(path.dirname(cachePath), { recursive: true });
    await fsPromises.writeFile(cachePath, Buffer.from('stale'));
    authoritative.objects.set(key, Buffer.from('old'));
    service = new S3ThumbnailCacheService({
      storage: authoritative,
      cacheRoot,
      maxBytes: 1024,
    });
    const readdir = vi.spyOn(fsPromises, 'readdir').mockRejectedValueOnce(
      Object.assign(new Error('transient index failure'), { code: 'EIO' }),
    );

    await service.store(key, Buffer.from('new'));
    await expect(fsPromises.stat(cachePath)).rejects.toMatchObject({ code: 'ENOENT' });
    readdir.mockRestore();

    service = new S3ThumbnailCacheService({
      storage: authoritative,
      cacheRoot,
      maxBytes: 1024,
    });
    await expect(service.retrieve(key)).resolves.toEqual(Buffer.from('new'));
  });

  it('falls back to authoritative S3 reads and writes when cache I/O fails', async () => {
    const unusableRoot = path.join(cacheRoot, 'not-a-directory');
    await fsPromises.writeFile(unusableRoot, Buffer.from('file'));
    service = new S3ThumbnailCacheService({
      storage: authoritative,
      cacheRoot: unusableRoot,
      maxBytes: 1024,
    });
    const key = 'thumbnails/model-1/preview.webp';
    authoritative.objects.set(key, Buffer.from('authoritative'));

    await expect(service.retrieve(key)).resolves.toEqual(Buffer.from('authoritative'));
    await expect(service.store(key, Buffer.from('updated'))).resolves.toMatchObject({
      etag: 'etag',
    });
    expect(authoritative.objects.get(key)).toEqual(Buffer.from('updated'));
  });
});
