import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { LocalStorageService, type IStorageService } from './storage.service.js';
import { migrateLocalStorage } from './storage-migration.service.js';

function md5(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fsPromises.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('migrateLocalStorage', () => {
  it('copies nested objects and reports progress', async () => {
    const source = await createLocalStorage();
    const target = await createLocalStorage();
    await source.store('models/one/model.stl', Buffer.from('mesh'));
    await source.store('thumbnails/one/preview.webp', Buffer.from('preview'));
    const onProgress = vi.fn();

    const result = await migrateLocalStorage(source, target, onProgress);

    expect(result).toEqual({ copied: 2, skipped: 0, total: 2 });
    await expect(target.retrieve('models/one/model.stl')).resolves.toEqual(Buffer.from('mesh'));
    await expect(target.retrieve('thumbnails/one/preview.webp')).resolves.toEqual(
      Buffer.from('preview'),
    );
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it('skips objects whose size and SHA-256 digest already match', async () => {
    const source = await createLocalStorage();
    const target = await createLocalStorage();
    await source.store('models/one/model.stl', Buffer.from('same'));
    await target.store('models/one/model.stl', Buffer.from('same'));
    const storeSpy = vi.spyOn(target, 'store');

    const result = await migrateLocalStorage(source, target);

    expect(result).toEqual({ copied: 0, skipped: 1, total: 1 });
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it('replaces an existing object when its digest differs', async () => {
    const source = await createLocalStorage();
    const target = await createLocalStorage();
    await source.store('models/one/model.stl', Buffer.from('new-value'));
    await target.store('models/one/model.stl', Buffer.from('old-value'));

    const result = await migrateLocalStorage(source, target);

    expect(result).toEqual({ copied: 1, skipped: 0, total: 1 });
    await expect(target.retrieve('models/one/model.stl')).resolves.toEqual(
      Buffer.from('new-value'),
    );
  });

  it('does not read copied objects back from a remote target', async () => {
    const source = await createLocalStorage();
    await source.store('models/one/model.stl', Buffer.from('mesh'));
    await source.store('models/two/model.stl', Buffer.from('another mesh'));

    const target = await createRemoteLikeTarget();
    const retrieveSpy = vi.spyOn(target, 'retrieveStream');

    const result = await migrateLocalStorage(source, target);

    expect(result).toEqual({ copied: 2, skipped: 0, total: 2 });
    // Verification happens against the ETag reported at upload time, so a
    // migration moves each byte once instead of twice.
    expect(retrieveSpy).not.toHaveBeenCalled();
  });

  it('deletes the target object and stops when verification fails', async () => {
    const source = await createLocalStorage();
    await source.store('models/one/model.stl', Buffer.from('mesh'));

    // A target that stores something other than what it was sent.
    const target = await createRemoteLikeTarget({ etagOf: () => md5(Buffer.from('wrong')) });
    const deleteSpy = vi.spyOn(target, 'delete');

    await expect(migrateLocalStorage(source, target)).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
    });
    expect(deleteSpy).toHaveBeenCalledWith('models/one/model.stl');
  });

  it('reports progress counts that account for out-of-order completion', async () => {
    const source = await createLocalStorage();
    for (let index = 0; index < 6; index++) {
      await source.store(`models/${index}/model.stl`, Buffer.from(`mesh-${index}`));
    }
    const target = await createRemoteLikeTarget();
    const onProgress = vi.fn();

    await migrateLocalStorage(source, target, onProgress);

    const currents = onProgress.mock.calls.map(([event]) => event.current);
    // Uploads overlap, so `current` counts completions rather than indexing the
    // file list; it must still cover 1..n exactly once.
    expect([...currents].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(onProgress.mock.calls.every(([event]) => event.total === 6)).toBe(true);
  });

  it('fails when the configured local source directory does not exist', async () => {
    const target = await createLocalStorage();
    const missingSource = new LocalStorageService(
      path.join(os.tmpdir(), `alexandria-missing-storage-${Date.now()}`),
    );

    await expect(migrateLocalStorage(missingSource, target)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

async function createLocalStorage(): Promise<LocalStorageService> {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'alexandria-storage-test-'));
  temporaryDirectories.push(directory);
  return new LocalStorageService(directory);
}

/**
 * A target that behaves like an object store: it reports an ETag for what it
 * received, so `storeVerified` can check the upload without reading it back.
 */
async function createRemoteLikeTarget(
  options: { etagOf?: (received: Buffer) => string } = {},
): Promise<IStorageService> {
  const backing = await createLocalStorage();

  return new Proxy(backing as unknown as IStorageService, {
    get(realTarget, property, receiver) {
      if (property === 'kind') return 's3';
      if (property === 'uploadPartSize') return 8 * 1024 * 1024;
      if (property === 'store') {
        return async (key: string, data: Buffer | NodeJS.ReadableStream) => {
          const chunks: Buffer[] = [];
          if (Buffer.isBuffer(data)) {
            chunks.push(data);
          } else {
            for await (const chunk of data) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
          }
          const received = Buffer.concat(chunks);
          await backing.store(key, received);
          return {
            etag: options.etagOf ? options.etagOf(received) : md5(received),
            partSize: 8 * 1024 * 1024,
          };
        };
      }
      return Reflect.get(realTarget, property, receiver);
    },
  });
}
