import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { UploadService } from './upload.service.js';

describe('UploadService – multipart assembly', () => {
  let service: UploadService | undefined;

  afterEach(() => {
    service?.destroy();
    service = undefined;
  });

  it('preflights ownership for the entire group before consuming a member', async () => {
    service = new UploadService();
    const owned = service.initUpload('owned.zip', 1, 1, 'user-1');
    const foreign = service.initUpload('foreign.zip', 1, 1, 'user-2');
    await service.receiveChunk(owned.uploadId, 0, Readable.from(Buffer.from('a')), 'user-1');

    await expect(service.assembleFiles(
      [owned.uploadId, foreign.uploadId],
      'user-1',
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const assembled = await service.assembleFile(owned.uploadId, 'user-1');
    expect(await fsPromises.readFile(assembled.tempFilePath, 'utf8')).toBe('a');
    await fsPromises.rm(assembled.tempFilePath, { force: true });
  });

  it('removes completed and partial temp files when a later member fails assembly', async () => {
    service = new UploadService();
    const first = service.initUpload('first.zip', 1, 1, 'user-1');
    const second = service.initUpload('second.zip', 2, 1, 'user-1');
    await service.receiveChunk(first.uploadId, 0, Readable.from(Buffer.from('a')), 'user-1');
    await service.receiveChunk(second.uploadId, 0, Readable.from(Buffer.from('b')), 'user-1');

    await expect(service.assembleFiles(
      [first.uploadId, second.uploadId],
      'user-1',
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const firstTemp = path.join(os.tmpdir(), `upload_${first.uploadId}_first.zip`);
    const secondTemp = path.join(os.tmpdir(), `upload_${second.uploadId}_second.zip`);
    await expect(fsPromises.access(firstTemp)).rejects.toThrow();
    await expect(fsPromises.access(secondTemp)).rejects.toThrow();
  });

  it('bounds streamed chunks by declared total size and preserves an overwritten chunk on rejection', async () => {
    service = new UploadService();
    const upload = service.initUpload('bounded.zip', 4, 2, 'user-1');
    await service.receiveChunk(upload.uploadId, 0, Readable.from(Buffer.from('ab')), 'user-1');
    await service.receiveChunk(upload.uploadId, 1, Readable.from(Buffer.from('cd')), 'user-1');

    await expect(service.receiveChunk(
      upload.uploadId,
      0,
      Readable.from([Buffer.from('abc'), Buffer.from('de')]),
      'user-1',
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const assembled = await service.assembleFile(upload.uploadId, 'user-1');
    expect(await fsPromises.readFile(assembled.tempFilePath, 'utf8')).toBe('abcd');
    await fsPromises.rm(assembled.tempFilePath, { force: true });
  });

  it('bounds concurrent chunk writes by the declared aggregate total size', async () => {
    service = new UploadService();
    const upload = service.initUpload('concurrent.zip', 4, 2, 'user-1');

    const results = await Promise.allSettled([
      service.receiveChunk(upload.uploadId, 0, Readable.from(Buffer.from('abc')), 'user-1'),
      service.receiveChunk(upload.uploadId, 1, Readable.from(Buffer.from('def')), 'user-1'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      }),
    ]);

    const rejectedIndex = results.findIndex((result) => result.status === 'rejected');
    await service.receiveChunk(
      upload.uploadId,
      rejectedIndex,
      Readable.from(Buffer.from('x')),
      'user-1',
    );
    const assembled = await service.assembleFile(upload.uploadId, 'user-1');
    const bytes = await fsPromises.readFile(assembled.tempFilePath);
    expect(bytes).toHaveLength(4);
    await fsPromises.rm(assembled.tempFilePath, { force: true });
  });

  it('aborts only an owned upload, hides ownership, and removes chunk storage', async () => {
    service = new UploadService();
    const upload = service.initUpload('abort.zip', 1, 1, 'user-1');
    await service.receiveChunk(upload.uploadId, 0, Readable.from(Buffer.from('a')), 'user-1');
    const chunksDir = path.join(os.tmpdir(), `alexandria_chunks_${upload.uploadId}`);

    await expect(service.abortUpload(upload.uploadId, 'user-2')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(fsPromises.access(chunksDir)).resolves.toBeUndefined();

    await expect(service.abortUpload(upload.uploadId, 'user-1')).resolves.toBeUndefined();
    await expect(fsPromises.access(chunksDir)).rejects.toThrow();
    await expect(service.abortUpload(upload.uploadId, 'user-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('allows only one concurrent completion to consume a session', async () => {
    service = new UploadService();
    const upload = service.initUpload('complete-once.zip', 1, 1, 'user-1');
    await service.receiveChunk(upload.uploadId, 0, Readable.from(Buffer.from('a')), 'user-1');

    const results = await Promise.allSettled([
      service.assembleFile(upload.uploadId, 'user-1'),
      service.assembleFile(upload.uploadId, 'user-1'),
    ]);

    const completed = results.find((result) => result.status === 'fulfilled');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'NOT_FOUND' }) }),
    ]);
    if (completed?.status === 'fulfilled') {
      await fsPromises.rm(completed.value.tempFilePath, { force: true });
    }
  });

  it('atomically claims overlapping multipart completion groups', async () => {
    service = new UploadService();
    const first = service.initUpload('first.zip', 1, 1, 'user-1');
    const shared = service.initUpload('shared.zip', 1, 1, 'user-1');
    const untouched = service.initUpload('untouched.zip', 1, 1, 'user-1');
    await Promise.all([
      service.receiveChunk(first.uploadId, 0, Readable.from(Buffer.from('a')), 'user-1'),
      service.receiveChunk(shared.uploadId, 0, Readable.from(Buffer.from('b')), 'user-1'),
      service.receiveChunk(untouched.uploadId, 0, Readable.from(Buffer.from('c')), 'user-1'),
    ]);

    const results = await Promise.allSettled([
      service.assembleFiles([first.uploadId, shared.uploadId], 'user-1'),
      service.assembleFiles([shared.uploadId, untouched.uploadId], 'user-1'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'NOT_FOUND' }) }),
    ]);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        await Promise.all(result.value.map((file) => fsPromises.rm(file.tempFilePath, { force: true })));
      }
    }

    const remaining = await Promise.allSettled([
      service.assembleFile(first.uploadId, 'user-1'),
      service.assembleFile(untouched.uploadId, 'user-1'),
    ]);
    const stillAvailable = remaining.find((result) => result.status === 'fulfilled');
    expect(remaining.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    if (stillAvailable?.status === 'fulfilled') {
      await fsPromises.rm(stillAvailable.value.tempFilePath, { force: true });
    }
  });

  it('serializes abort behind an active write and prevents later use', async () => {
    service = new UploadService();
    const upload = service.initUpload('write-then-abort.zip', 1, 1, 'user-1');

    const write = service.receiveChunk(
      upload.uploadId,
      0,
      Readable.from(Buffer.from('a')),
      'user-1',
    );
    const abort = service.abortUpload(upload.uploadId, 'user-1');

    await expect(write).resolves.toEqual({ received: 1 });
    await expect(abort).resolves.toBeUndefined();
    await expect(service.assembleFile(upload.uploadId, 'user-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('makes a write queued behind abort fail without recreating storage', async () => {
    service = new UploadService();
    const upload = service.initUpload('abort-then-write.zip', 1, 1, 'user-1');

    const abort = service.abortUpload(upload.uploadId, 'user-1');
    const write = service.receiveChunk(
      upload.uploadId,
      0,
      Readable.from(Buffer.from('a')),
      'user-1',
    );

    await expect(abort).resolves.toBeUndefined();
    await expect(write).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
