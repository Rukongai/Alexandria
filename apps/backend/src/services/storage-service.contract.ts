import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../utils/errors.js';

export interface StorageContractService {
  store(key: string, data: Buffer | NodeJS.ReadableStream): Promise<unknown>;
  retrieve(key: string): Promise<Buffer>;
  retrieveStream(key: string): Promise<Readable>;
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<{ filePath: string; reason: string }[]>;
  exists(key: string): Promise<boolean>;
}

export interface StorageContractFixture {
  service: StorageContractService;
  cleanup?: () => Promise<void>;
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Contract shared by every managed-storage provider.
 *
 * Each test receives a new provider fixture so providers may safely point this
 * at either a temporary directory or an isolated object-key prefix.
 */
export function describeStorageServiceContract(
  providerName: string,
  createFixture: () => Promise<StorageContractFixture>,
): void {
  describe(`${providerName} storage provider contract`, () => {
    let fixture: StorageContractFixture;

    beforeEach(async () => {
      fixture = await createFixture();
    });

    afterEach(async () => {
      await fixture.cleanup?.();
    });

    it('should store and retrieve buffer content when directories are nested', async () => {
      const content = Buffer.from('nested buffer content');

      await fixture.service.store('models/abc/files/model.stl', content);

      await expect(fixture.service.retrieve('models/abc/files/model.stl')).resolves.toEqual(content);
      await expect(fixture.service.exists('models/abc/files/model.stl')).resolves.toBe(true);
    });

    it('should store readable stream content when input is streamed', async () => {
      const content = Buffer.from('streamed storage content');

      await fixture.service.store('models/abc/stream.bin', Readable.from([content]));

      await expect(fixture.service.retrieve('models/abc/stream.bin')).resolves.toEqual(content);
    });

    it('should normalize redundant separators and dot segments in keys', async () => {
      const content = Buffer.from('normalized');

      await fixture.service.store('./models//abc/./normalized.bin', content);

      await expect(fixture.service.retrieve('models/abc/normalized.bin')).resolves.toEqual(content);
    });

    it('should reject keys that traverse outside managed storage', async () => {
      const attempts = [
        () => fixture.service.store('../escaped.bin', Buffer.from('nope')),
        () => fixture.service.retrieve('../../escaped.bin'),
        () => fixture.service.retrieveStream('models/../../../escaped.bin'),
        () => fixture.service.copy('../source.bin', 'destination.bin'),
        () => fixture.service.copy('source.bin', '../destination.bin'),
        () => fixture.service.delete('../escaped.bin'),
        () => fixture.service.exists('../escaped.bin'),
      ];

      for (const attempt of attempts) {
        await expect(attempt()).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
      }
    });

    it('should retrieve content as a readable stream', async () => {
      const content = Buffer.from('stream this content');
      await fixture.service.store('models/stream.txt', content);

      const stream = await fixture.service.retrieveStream('models/stream.txt');

      expect(stream).toBeInstanceOf(Readable);
      await expect(readStream(stream)).resolves.toEqual(content);
    });

    it('should copy content without removing the source', async () => {
      const content = Buffer.from('copy this content');
      await fixture.service.store('models/source.bin', content);

      await fixture.service.copy('models/source.bin', 'models/copies/destination.bin');

      await expect(fixture.service.retrieve('models/source.bin')).resolves.toEqual(content);
      await expect(fixture.service.retrieve('models/copies/destination.bin')).resolves.toEqual(content);
    });

    it('should delete idempotently when the key exists or is already absent', async () => {
      await fixture.service.store('models/delete-me.bin', Buffer.from('temporary'));

      await fixture.service.delete('models/delete-me.bin');
      await fixture.service.delete('models/delete-me.bin');

      await expect(fixture.service.exists('models/delete-me.bin')).resolves.toBe(false);
    });

    it('should delete many objects and report no failures', async () => {
      const keys = ['models/a.bin', 'models/b.bin', 'models/nested/c.bin'];
      for (const key of keys) await fixture.service.store(key, Buffer.from(key));

      await expect(fixture.service.deleteMany(keys)).resolves.toEqual([]);

      for (const key of keys) {
        await expect(fixture.service.exists(key)).resolves.toBe(false);
      }
    });

    it('should treat an already absent key in a batch as deleted', async () => {
      await fixture.service.store('models/present.bin', Buffer.from('here'));

      const failures = await fixture.service.deleteMany([
        'models/present.bin',
        'models/never-existed.bin',
      ]);

      expect(failures).toEqual([]);
      await expect(fixture.service.exists('models/present.bin')).resolves.toBe(false);
    });

    it('should report an unusable key without abandoning the rest of the batch', async () => {
      await fixture.service.store('models/keep-going.bin', Buffer.from('data'));

      const failures = await fixture.service.deleteMany([
        '../escaped.bin',
        'models/keep-going.bin',
      ]);

      expect(failures).toHaveLength(1);
      expect(failures[0]?.filePath).toBe('../escaped.bin');
      // The valid key in the same call is still deleted.
      await expect(fixture.service.exists('models/keep-going.bin')).resolves.toBe(false);
    });

    it('should accept an empty batch', async () => {
      await expect(fixture.service.deleteMany([])).resolves.toEqual([]);
    });

    it('should map a missing object retrieval to a storage error', async () => {
      const result = fixture.service.retrieve('missing/object.bin');

      await expect(result).rejects.toBeInstanceOf(AppError);
      await expect(result).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    });

    it('should map a missing object stream to a storage error', async () => {
      const result = fixture.service.retrieveStream('missing/stream.bin');

      await expect(result).rejects.toBeInstanceOf(AppError);
      await expect(result).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    });
  });
}
