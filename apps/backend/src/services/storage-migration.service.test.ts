import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalStorageService } from './storage.service.js';
import { migrateLocalStorage } from './storage-migration.service.js';

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
