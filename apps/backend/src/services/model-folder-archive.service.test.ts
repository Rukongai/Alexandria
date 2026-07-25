import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { path7z } from '7zip-bin-full';
import { FileProcessingService } from './file-processing.service.js';
import { ModelFolderArchiveService } from './model-folder-archive.service.js';
import type { ModelService } from './model.service.js';
import type {
  IStorageService,
  StorageData,
  StoreResult,
} from './storage.service.js';

const execFileAsync = promisify(execFile);
let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'alex-folder-archive-test-'));
});

afterAll(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

function memoryStorage(initial: Record<string, string>): {
  storage: IStorageService;
  objects: Map<string, Buffer>;
} {
  const objects: Map<string, Buffer> = new Map(
    Object.entries(initial).map(([key, value]) => [key, Buffer.from(value)]),
  );
  const storage: IStorageService = {
    kind: 's3',
    async store(key: string, data: StorageData): Promise<StoreResult> {
      objects.set(key, Buffer.isBuffer(data) ? data : await buffer(data));
      return {};
    },
    async retrieve(key: string): Promise<Buffer> {
      const value = objects.get(key);
      if (!value) throw new Error(`Missing object: ${key}`);
      return value;
    },
    async retrieveStream(key: string): Promise<Readable> {
      return Readable.from(await this.retrieve(key));
    },
    async copy(source: string, destination: string): Promise<void> {
      objects.set(destination, await this.retrieve(source));
    },
    async delete(key: string): Promise<void> {
      objects.delete(key);
    },
    async exists(key: string): Promise<boolean> {
      return objects.has(key);
    },
  };
  return { storage, objects };
}

function modelService(options: {
  files?: Array<{ relativePath: string; storagePath: string }>;
  folders?: Array<{ path: string }>;
  persist?: ReturnType<typeof vi.fn>;
} = {}): ModelService {
  return {
    normalizeFolderPath: vi.fn((value: string) => {
      if (value.length > 1000 || value.split('/').some((segment) => segment.length > 255)) {
        throw new Error('Path exceeds model path limits');
      }
      return value;
    }),
    getModelFiles: vi.fn().mockResolvedValue(options.files ?? []),
    getModelFolders: vi.fn().mockResolvedValue(options.folders ?? []),
    createModelFileAndRecalculateStats:
      options.persist ?? vi.fn().mockResolvedValue({ id: 'archive-file-1' }),
  } as unknown as ModelService;
}

describe('ModelFolderArchiveService', () => {
  it('streams a folder through storage and persists a non-destructive sibling archive', async () => {
    const { storage, objects } = memoryStorage({
      'models/model-1/parts/body.stl': 'solid body',
      'models/model-1/parts/docs/readme.txt': 'print slowly',
    });
    const persist = vi.fn().mockResolvedValue({ id: 'archive-file-1' });
    const models = modelService({
      files: [
        { relativePath: 'parts/body.stl', storagePath: 'models/model-1/parts/body.stl' },
        { relativePath: 'parts/docs/readme.txt', storagePath: 'models/model-1/parts/docs/readme.txt' },
      ],
      folders: [{ path: 'parts' }, { path: 'parts/empty' }],
      persist,
    });
    const service = new ModelFolderArchiveService(
      models,
      storage,
      new FileProcessingService(),
    );

    const result = await service.compressFolder('model-1', 'parts');

    expect(result).toMatchObject({
      archiveFileId: 'archive-file-1',
      archivePath: 'parts.7z',
    });
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(objects.get('models/model-1/parts/body.stl')?.toString()).toBe('solid body');
    expect(objects.get('models/model-1/parts/docs/readme.txt')?.toString()).toBe('print slowly');
    expect(persist).toHaveBeenCalledWith(
      'model-1',
      expect.objectContaining({
        filename: 'parts.7z',
        relativePath: 'parts.7z',
        fileType: 'other',
        mimeType: 'application/x-7z-compressed',
        sizeBytes: result.sizeBytes,
        storagePath: 'models/model-1/parts.7z',
        hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );

    const archiveFixture = path.join(tmpDir, 'stored-parts.7z');
    await fsPromises.writeFile(archiveFixture, objects.get('models/model-1/parts.7z')!);
    const { stdout } = await execFileAsync(path7z, ['l', '-slt', archiveFixture]);
    expect(stdout).toContain('Method = LZMA2');
    expect(stdout).toContain('Path = body.stl');
    expect(stdout).toContain('Path = docs/readme.txt');
    expect(stdout).toContain('Path = empty');
    expect(stdout).not.toContain('Path = parts/body.stl');
  });

  it('rejects an occupied sibling path before reading or writing storage', async () => {
    const { storage } = memoryStorage({});
    const create7zArchive = vi.fn();
    const service = new ModelFolderArchiveService(
      modelService({
        files: [
          { relativePath: 'parts/body.stl', storagePath: 'models/model-1/parts/body.stl' },
          { relativePath: 'parts.7z', storagePath: 'models/model-1/parts.7z' },
        ],
        folders: [{ path: 'parts' }],
      }),
      storage,
      { create7zArchive } as unknown as FileProcessingService,
    );

    await expect(service.compressFolder('model-1', 'parts')).rejects.toMatchObject({
      code: 'CONFLICT',
      statusCode: 409,
    });
    expect(create7zArchive).not.toHaveBeenCalled();
  });

  it('serializes concurrent compression of the same folder', async () => {
    const { storage } = memoryStorage({
      'models/model-1/parts/body.stl': 'solid body',
    });
    const actualFileProcessing = new FileProcessingService();
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseCreation!: () => void;
    const creationGate = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    const create7zArchive = vi.fn(async (sourceDir: string, archivePath: string) => {
      signalStarted();
      await creationGate;
      await actualFileProcessing.create7zArchive(sourceDir, archivePath);
    });
    const service = new ModelFolderArchiveService(
      modelService({
        files: [
          { relativePath: 'parts/body.stl', storagePath: 'models/model-1/parts/body.stl' },
        ],
        folders: [{ path: 'parts' }],
      }),
      storage,
      { create7zArchive } as unknown as FileProcessingService,
    );

    const first = service.compressFolder('model-1', 'parts');
    await started;
    const second = service.compressFolder('model-1', 'parts');
    await Promise.resolve();
    expect(create7zArchive).toHaveBeenCalledTimes(1);

    releaseCreation();
    await expect(first).resolves.toMatchObject({ archivePath: 'parts.7z' });
    await expect(second).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expect(create7zArchive).toHaveBeenCalledTimes(1);
  });

  it('limits compression work across different folders', async () => {
    const { storage } = memoryStorage({
      'models/model-1/parts-a/body.stl': 'solid a',
      'models/model-1/parts-b/body.stl': 'solid b',
    });
    const actualFileProcessing = new FileProcessingService();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const create7zArchive = vi.fn(async (sourceDir: string, archivePath: string) => {
      if (create7zArchive.mock.calls.length === 1) await firstGate;
      await actualFileProcessing.create7zArchive(sourceDir, archivePath);
    });
    const service = new ModelFolderArchiveService(
      modelService({
        files: [
          { relativePath: 'parts-a/body.stl', storagePath: 'models/model-1/parts-a/body.stl' },
          { relativePath: 'parts-b/body.stl', storagePath: 'models/model-1/parts-b/body.stl' },
        ],
        folders: [{ path: 'parts-a' }, { path: 'parts-b' }],
      }),
      storage,
      { create7zArchive } as unknown as FileProcessingService,
    );

    const first = service.compressFolder('model-1', 'parts-a');
    const second = service.compressFolder('model-1', 'parts-b');
    await vi.waitFor(() => expect(create7zArchive).toHaveBeenCalledTimes(1));

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(create7zArchive).toHaveBeenCalledTimes(2);
  });

  it('removes the stored archive when database persistence fails', async () => {
    const { storage, objects } = memoryStorage({
      'models/model-1/parts/body.stl': 'solid body',
    });
    const service = new ModelFolderArchiveService(
      modelService({
        files: [
          { relativePath: 'parts/body.stl', storagePath: 'models/model-1/parts/body.stl' },
        ],
        folders: [{ path: 'parts' }],
        persist: vi.fn().mockRejectedValue(new Error('database unavailable')),
      }),
      storage,
      new FileProcessingService(),
    );

    await expect(service.compressFolder('model-1', 'parts'))
      .rejects.toThrow('database unavailable');
    expect(objects.has('models/model-1/parts.7z')).toBe(false);
    expect(objects.get('models/model-1/parts/body.stl')?.toString()).toBe('solid body');
  });

  it('rejects a missing folder', async () => {
    const { storage } = memoryStorage({});
    const service = new ModelFolderArchiveService(
      modelService(),
      storage,
      new FileProcessingService(),
    );

    await expect(service.compressFolder('model-1', 'missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });

  it('validates the derived archive path before reading model contents', async () => {
    const { storage } = memoryStorage({});
    const models = modelService();
    const service = new ModelFolderArchiveService(
      models,
      storage,
      new FileProcessingService(),
    );

    await expect(service.compressFolder('model-1', 'x'.repeat(253)))
      .rejects.toThrow('Path exceeds model path limits');
    expect(models.getModelFiles).not.toHaveBeenCalled();
    expect(models.getModelFolders).not.toHaveBeenCalled();
  });
});
