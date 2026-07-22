import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { describeStorageServiceContract } from './storage-service.contract.js';
import { LocalStorageService, StorageService, isLocalStorageService } from './storage.service.js';

describeStorageServiceContract('LocalStorageService', async () => {
  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'alex-storage-test-'));
  return {
    service: new LocalStorageService(storageRoot),
    cleanup: () => fsPromises.rm(storageRoot, { recursive: true, force: true }),
  };
});

describe('LocalStorageService', () => {
  it('should expose its resolved filesystem root for local-only consumers', async () => {
    const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'alex-storage-root-test-'));
    try {
      const service = new LocalStorageService(path.join(storageRoot, 'nested', '..'));

      expect(service.kind).toBe('local');
      expect(service.getStorageRoot()).toBe(path.resolve(storageRoot));
      expect(service.resolveStoragePath('models/file.stl')).toBe(
        path.join(path.resolve(storageRoot), 'models', 'file.stl'),
      );
      expect(isLocalStorageService(service)).toBe(true);
    } finally {
      await fsPromises.rm(storageRoot, { recursive: true, force: true });
    }
  });

  it('should retain StorageService as a compatible local provider alias', async () => {
    const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'alex-storage-alias-test-'));
    try {
      const service = new StorageService(storageRoot);

      expect(service).toBeInstanceOf(LocalStorageService);
      expect(isLocalStorageService(service)).toBe(true);
    } finally {
      await fsPromises.rm(storageRoot, { recursive: true, force: true });
    }
  });

  it('should report completed bytes for buffer and stream writes', async () => {
    const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'alex-storage-progress-test-'));
    try {
      const service = new LocalStorageService(storageRoot);
      const bufferProgress = vi.fn();
      const streamProgress = vi.fn();

      await service.store('buffers/file.bin', Buffer.from('buffer'), bufferProgress);
      await service.store(
        'streams/file.bin',
        Readable.from([Buffer.from('streamed')]),
        streamProgress,
      );

      expect(bufferProgress).toHaveBeenLastCalledWith(6);
      expect(streamProgress).toHaveBeenLastCalledWith(8);
    } finally {
      await fsPromises.rm(storageRoot, { recursive: true, force: true });
    }
  });

  it('should not fail a completed write when the progress callback throws', async () => {
    const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'alex-storage-progress-error-'));
    try {
      const service = new LocalStorageService(storageRoot);

      await expect(
        service.store('models/file.bin', Buffer.from('content'), () => {
          throw new Error('observer failed');
        }),
      ).resolves.toBeUndefined();
      await expect(service.retrieve('models/file.bin')).resolves.toEqual(Buffer.from('content'));
    } finally {
      await fsPromises.rm(storageRoot, { recursive: true, force: true });
    }
  });

  it('should map filesystem write and delete failures to storage errors', async () => {
    const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'alex-storage-error-test-'));
    try {
      const service = new LocalStorageService(storageRoot);

      await expect(service.store('\0invalid', Buffer.from('x'))).rejects.toMatchObject({
        code: 'STORAGE_ERROR',
      });
      await expect(service.delete('\0invalid')).rejects.toMatchObject({
        code: 'STORAGE_ERROR',
      });
    } finally {
      await fsPromises.rm(storageRoot, { recursive: true, force: true });
    }
  });
});
