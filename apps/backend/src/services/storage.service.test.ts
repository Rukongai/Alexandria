import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { describeStorageServiceContract } from './storage-service.contract.js';
import {
  LocalStorageService,
  StorageService,
  isLocalStorageService,
  storeVerified,
  uploadConcurrencyFor,
  type IStorageService,
  type StorageData,
  type StoreResult,
} from './storage.service.js';

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
      ).resolves.toEqual({});
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

// ---------------------------------------------------------------------------
// storeVerified
// ---------------------------------------------------------------------------

const PART_SIZE = 8 * 1024 * 1024;

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function md5(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

/**
 * A backend that behaves like a real one: it consumes the body it is handed and
 * reports an ETag derived from the bytes it actually received.
 */
function fakeBackend(options: {
  kind?: 'local' | 's3';
  uploadPartSize?: number;
  /** Corrupt what the backend "receives" to simulate a bad transfer. */
  corrupt?: (received: Buffer) => Buffer;
  etag?: (received: Buffer) => string | undefined;
} = {}): { storage: IStorageService; received: () => Buffer } {
  let received = Buffer.alloc(0);

  const storage = {
    kind: options.kind ?? 's3',
    uploadPartSize: 'uploadPartSize' in options ? options.uploadPartSize : PART_SIZE,
    async store(_path: string, data: StorageData): Promise<StoreResult> {
      const chunks: Buffer[] = [];
      if (Buffer.isBuffer(data)) {
        chunks.push(data);
      } else {
        for await (const chunk of data) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      }
      received = Buffer.concat(chunks);
      const stored = options.corrupt ? options.corrupt(received) : received;
      const etag = options.etag ? options.etag(stored) : md5(stored);
      return { etag, partSize: storage.uploadPartSize };
    },
  } as unknown as IStorageService;

  return { storage, received: () => received };
}

describe('storeVerified', () => {
  const content = Buffer.from('a model file worth verifying');

  it('accepts an upload whose ETag matches the bytes sent', async () => {
    const { storage, received } = fakeBackend();

    const result = await storeVerified(storage, 'models/a.stl', () => Readable.from(content), {
      expectedSha256: sha256(content),
      expectedSize: content.length,
    });

    expect(received()).toEqual(content);
    expect(result.etagVerified).toBe(true);
    expect(result.sha256).toBe(sha256(content));
    expect(result.sizeBytes).toBe(content.length);
  });

  it('rejects an upload the provider reports a different ETag for', async () => {
    // The provider received something other than what was sent.
    const { storage } = fakeBackend({ corrupt: () => Buffer.from('different bytes entirely') });

    await expect(
      storeVerified(storage, 'models/a.stl', () => Readable.from(content)),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });

  it('rejects a source whose contents no longer hash to the recorded value', async () => {
    const { storage } = fakeBackend();

    await expect(
      storeVerified(storage, 'models/a.stl', () => Readable.from(content), {
        expectedSha256: sha256(Buffer.from('what the scan saw')),
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });

  it('rejects a source that is no longer the size that was recorded', async () => {
    const { storage } = fakeBackend();

    await expect(
      storeVerified(storage, 'models/a.stl', () => Readable.from(content), {
        expectedSize: content.length + 1,
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });

  it('verifies a multipart ETag across part boundaries', async () => {
    // Two full parts plus a remainder, so the digest-of-digests form is used.
    const large = Buffer.alloc(PART_SIZE * 2 + 1024, 'x');
    const { storage } = fakeBackend({
      etag: (stored) => {
        const digests: Buffer[] = [];
        for (let offset = 0; offset < stored.length; offset += PART_SIZE) {
          digests.push(
            createHash('md5').update(stored.subarray(offset, offset + PART_SIZE)).digest(),
          );
        }
        return `${md5(Buffer.concat(digests))}-${digests.length}`;
      },
    });

    const result = await storeVerified(storage, 'models/large.stl', () => Readable.from(large));
    expect(result.etagVerified).toBe(true);
  });

  it('reports verification as unavailable when the backend has no ETag', async () => {
    const { storage } = fakeBackend({ kind: 'local', uploadPartSize: undefined });

    const result = await storeVerified(storage, 'models/a.stl', () => Readable.from(content), {
      expectedSha256: sha256(content),
    });

    // No ETag to compare is not the same as a failed comparison, but the
    // SHA-256 check still ran.
    expect(result.etagVerified).toBe(false);
    expect(result.sha256).toBe(sha256(content));
  });

  it('surfaces a failure to read the source rather than storing a truncated object', async () => {
    const { storage } = fakeBackend();
    const failing = (): Readable =>
      new Readable({
        read() {
          this.destroy(new Error('disk read failed'));
        },
      });

    await expect(storeVerified(storage, 'models/a.stl', failing)).rejects.toThrow();
  });
});

describe('uploadConcurrencyFor', () => {
  const appConfig = { storageUploadConcurrency: 8 } as never;

  it('fans out on a remote backend', () => {
    expect(uploadConcurrencyFor({ kind: 's3' } as IStorageService, appConfig)).toBe(8);
  });

  it('stays sequential on the local filesystem', () => {
    expect(uploadConcurrencyFor({ kind: 'local' } as IStorageService, appConfig)).toBe(1);
  });
});
