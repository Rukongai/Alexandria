import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelFile } from '../db/schema/model-file.js';
import { AppError } from '../utils/errors.js';
import { ArchiveBrowserService } from './archive-browser.service.js';

const createdDirectories: string[] = [];

function fileRow(overrides: Partial<ModelFile> = {}): ModelFile {
  return {
    id: 'file-id',
    modelId: 'model-id',
    filename: 'parts.7z',
    relativePath: 'parts.7z',
    fileType: 'other',
    mimeType: 'application/x-7z-compressed',
    sizeBytes: 1,
    storagePath: 'models/model-id/parts.7z',
    hash: 'a'.repeat(64),
    isDuplicate: false,
    createdAt: new Date(),
    ...overrides,
  };
}

function createService(files: ModelFile[] = [fileRow()]) {
  const models = {
    requireModelInLibrary: vi.fn().mockResolvedValue({ id: 'model-id' }),
    getModelFiles: vi.fn().mockResolvedValue(files),
  };
  const storage = {
    retrieveStream: vi.fn().mockResolvedValue(Readable.from([Buffer.from('archive')])),
  };
  const processing = {
    processArchive: vi.fn(async (_archivePath: string, extractDir: string) => {
      createdDirectories.push(extractDir);
      await fs.mkdir(extractDir, { recursive: true });
      await fs.mkdir(`${extractDir}/nested`, { recursive: true });
      await fs.writeFile(`${extractDir}/nested/part.stl`, 'mesh');
      return {
        entries: [{ relativePath: 'nested/part.stl', sizeBytes: 4 }],
        totalSizeBytes: 4,
      };
    }),
  };
  return {
    service: new ArchiveBrowserService(models as never, storage as never, processing as never),
    models,
  };
}

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe('ArchiveBrowserService', () => {
  it('returns files and inferred directories for an owned archive', async () => {
    const { service, models } = createService();

    await expect(service.list('model-id', 'file-id', 'library-id')).resolves.toEqual({
      entries: [
        { path: 'nested', sizeBytes: 0, isDirectory: true },
        { path: 'nested/part.stl', sizeBytes: 4, isDirectory: false },
      ],
    });
    expect(models.requireModelInLibrary).toHaveBeenCalledWith('model-id', 'library-id');
  });

  it('rejects a requested path that is not in the freshly extracted manifest', async () => {
    const { service } = createService();

    await expect(service.download('model-id', 'file-id', 'library-id', 'nested/missing.stl'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects traversal before looking up an archive entry', async () => {
    const { service } = createService();

    await expect(service.download('model-id', 'file-id', 'library-id', '../secret.stl'))
      .rejects.toBeInstanceOf(AppError);
  });

  it('streams one freshly validated entry', async () => {
    const { service } = createService();
    const entry = await service.download('model-id', 'file-id', 'library-id', 'nested/part.stl');

    await expect(read(entry.stream)).resolves.toEqual('mesh');
    expect(entry).toMatchObject({ filename: 'part.stl', sizeBytes: 4 });
  });
});

async function read(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}
