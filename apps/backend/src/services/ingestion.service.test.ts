import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

const fsMocks = vi.hoisted(() => ({
  createReadStream: vi.fn<() => NodeJS.ReadableStream>(
    () => ({ pipe: vi.fn() }) as unknown as NodeJS.ReadableStream,
  ),
}));
const databaseMocks = vi.hoisted(() => {
  const tx = { kind: 'transaction' };
  return {
    tx,
    transaction: vi.fn(async (callback: (executor: unknown) => unknown) => callback(tx)),
  };
});

vi.mock('../db/index.js', () => ({
  db: { transaction: databaseMocks.transaction },
}));

// ---------------------------------------------------------------------------
// Mock all collaborating services before the IngestionService module is
// imported, so the singletons exported from those modules are replaced with
// vi.fn() stubs throughout the tests.
// ---------------------------------------------------------------------------

vi.mock('./model.service.js', () => ({
  modelService: {
    createModel: vi.fn(),
    createModelFiles: vi.fn(),
    createThumbnails: vi.fn(),
    updateModelStatus: vi.fn(),
    getModelById: vi.fn(),
    requireOwnedModel: vi.fn(),
    getModelFiles: vi.fn(),
    getModelFolders: vi.fn(),
    recalculateModelStats: vi.fn(),
  },
  ModelService: vi.fn(),
}));

vi.mock('./job.service.js', () => ({
  jobService: {
    enqueueIngestionJob: vi.fn(),
    enqueueScanJob: vi.fn(),
    enqueueCommitJob: vi.fn(),
    enqueueFolderImportJob: vi.fn(),
  },
  JobService: vi.fn(),
}));

vi.mock('./file-processing.service.js', () => ({
  fileProcessingService: {
    processArchive: vi.fn(),
    processMultipartArchives: vi.fn(),
    validateMultipartArchives: vi.fn(),
    scanDirectory: vi.fn(),
    walkDirectoryForImport: vi.fn(),
    copyManifestToStorage: vi.fn().mockResolvedValue(undefined),
  },
  FileProcessingService: vi.fn(),
}));

vi.mock('./import-session.service.js', () => ({
  importSessionService: {
    create: vi.fn(),
    getRow: vi.fn(),
    getOwnedRow: vi.fn(),
    lockOwnedReadyForReviewSessions: vi.fn(),
    lockOwnedSessions: vi.fn(),
    update: vi.fn(),
    toDto: vi.fn(),
  },
  ImportSessionService: vi.fn(),
}));

vi.mock('./metadata.service.js', () => ({
  metadataService: {
    listFieldValues: vi.fn().mockResolvedValue([]),
    setModelMetadata: vi.fn().mockResolvedValue(undefined),
    getFieldBySlug: vi.fn().mockResolvedValue({ slug: 'field', type: 'text' }),
    validateFieldValue: vi.fn(),
  },
  MetadataService: vi.fn(),
}));

vi.mock('./thumbnail.service.js', () => ({
  thumbnailService: {
    generateThumbnails: vi.fn(),
  },
  ThumbnailService: vi.fn(),
}));

vi.mock('./collection.service.js', () => ({
  collectionService: {
    findOrCreateByName: vi.fn(),
    addModelToCollection: vi.fn(),
    requireOwnedCollection: vi.fn(),
  },
  CollectionService: vi.fn(),
}));

// Only the backend instance is faked. `storeVerified` and `uploadConcurrencyFor`
// keep their real implementations so these tests exercise the actual
// verification and fan-out logic rather than a stand-in for it.
vi.mock('./storage.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage.service.js')>();
  return {
    ...actual,
    storageService: {
      kind: 'local',
      uploadPartSize: 8 * 1024 * 1024,
      store: vi.fn(),
      delete: vi.fn(),
      retrieveStream: vi.fn().mockResolvedValue(Readable.from(Buffer.from('archive'))),
      resolveStoragePath: vi.fn(),
    },
    isLocalStorageService: vi.fn((storage) => storage.kind === 'local'),
    StorageService: vi.fn(),
  };
});

// node:fs is used for createReadStream inside processIngestionJob
vi.mock('node:fs', () => ({
  default: {
    createReadStream: fsMocks.createReadStream,
    createWriteStream: vi.fn().mockReturnValue(new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    })),
  },
}));

// node:fs/promises is used for rm (cleanup)
vi.mock('node:fs/promises', () => ({
  default: {
    rm: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn().mockResolvedValue('/tmp/alexandria-extract-test'),
    copyFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
    access: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' })),
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------
import { IngestionService } from './ingestion.service.js';
import { modelService } from './model.service.js';
import { jobService } from './job.service.js';
import { fileProcessingService } from './file-processing.service.js';
import { storageService } from './storage.service.js';
import { importSessionService } from './import-session.service.js';
import { metadataService } from './metadata.service.js';
import { collectionService } from './collection.service.js';
import fsPromises from 'node:fs/promises';
import { validationError } from '../utils/errors.js';
import { notFound } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeJob(): any {
  return {
    updateProgress: vi.fn().mockResolvedValue(undefined),
    opts: { attempts: 3 },
    attemptsMade: 2,
    failedReason: null,
  };
}

function makeManifest(entries = []) {
  return {
    entries,
    totalSizeBytes: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IngestionService – handleUpload', () => {
  let service: IngestionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new IngestionService();
  });

  it('should create model in processing state and enqueue job on handleUpload', async () => {
    vi.mocked(modelService.createModel).mockResolvedValue({ id: 'model-abc' });
    vi.mocked(jobService.enqueueIngestionJob).mockResolvedValue('job-xyz');

    const result = await service.handleUpload(
      { tempFilePath: '/tmp/upload.zip', originalFilename: 'my-model.zip' },
      'user-1',
      'library-1',
    );

    // Returns both IDs
    expect(result).toEqual({ modelId: 'model-abc', jobId: 'job-xyz' });

    // Model created with status 'processing', archive_upload source, and explicit libraryId
    expect(modelService.createModel).toHaveBeenCalledOnce();
    expect(modelService.createModel).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'processing',
        sourceType: 'archive_upload',
        originalFilename: 'my-model.zip',
        userId: 'user-1',
        libraryId: 'library-1',
      }),
    );

    // Job enqueued with correct payload including libraryId
    expect(jobService.enqueueIngestionJob).toHaveBeenCalledOnce();
    expect(jobService.enqueueIngestionJob).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'model-abc',
        tempFilePath: '/tmp/upload.zip',
        originalFilename: 'my-model.zip',
        userId: 'user-1',
        libraryId: 'library-1',
      }),
    );
  });

  it('should strip .zip extension from name when creating model', async () => {
    vi.mocked(modelService.createModel).mockResolvedValue({ id: 'model-abc' });
    vi.mocked(jobService.enqueueIngestionJob).mockResolvedValue('job-xyz');

    await service.handleUpload(
      { tempFilePath: '/tmp/upload.zip', originalFilename: 'Cool Model.zip' },
      'user-1',
      'library-1',
    );

    expect(modelService.createModel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Cool Model' }),
    );
  });

  it('should strip .rar extension from name when creating model', async () => {
    vi.mocked(modelService.createModel).mockResolvedValue({ id: 'model-abc' });
    vi.mocked(jobService.enqueueIngestionJob).mockResolvedValue('job-xyz');

    await service.handleUpload(
      { tempFilePath: '/tmp/upload.rar', originalFilename: 'Cool Model.rar' },
      'user-1',
      'library-1',
    );

    expect(modelService.createModel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Cool Model' }),
    );
  });

  it('should strip .tar.gz extension from name when creating model', async () => {
    vi.mocked(modelService.createModel).mockResolvedValue({ id: 'model-abc' });
    vi.mocked(jobService.enqueueIngestionJob).mockResolvedValue('job-xyz');

    await service.handleUpload(
      { tempFilePath: '/tmp/upload.tar.gz', originalFilename: 'Cool Model.tar.gz' },
      'user-1',
      'library-1',
    );

    expect(modelService.createModel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Cool Model' }),
    );
  });
});

describe('IngestionService – staged draft commit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseMocks.transaction.mockImplementation(
      async (callback: (executor: unknown) => unknown) => callback(databaseMocks.tx),
    );
  });

  it('uses a persisted draft when commit metadata is omitted', async () => {
    const service = new IngestionService();
    const draftMetadata = {
      modelName: 'Reviewed Dragon',
      collectionId: 'collection-1',
      metadata: { source: 'Fullmetal Alchemist' },
    };
    vi.mocked(importSessionService.lockOwnedSessions).mockResolvedValue([{
      id: 'session-1',
      userId: 'user-1',
      libraryId: 'library-1',
      status: 'ready_for_review',
      originalFilename: 'Maker - 2024 - Dragon.zip',
      draftMetadata,
    }] as never);
    vi.mocked(modelService.createModel).mockResolvedValue({ id: 'model-1' } as never);
    vi.mocked(jobService.enqueueCommitJob).mockResolvedValue('job-1');

    await service.handleCommit('session-1', undefined, 'user-1', 'library-1');

    expect(collectionService.requireOwnedCollection)
      .toHaveBeenCalledWith('collection-1', 'user-1', 'library-1', databaseMocks.tx);
    expect(modelService.createModel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Reviewed Dragon' }),
      databaseMocks.tx,
    );
    expect(importSessionService.update).toHaveBeenCalledWith(
      'session-1',
      { status: 'committing', modelId: 'model-1' },
      databaseMocks.tx,
    );
    expect(jobService.enqueueCommitJob).toHaveBeenCalledWith(expect.objectContaining({
      batchMetadata: draftMetadata,
    }));
  });

  it('uses explicit commit metadata instead of the persisted draft', async () => {
    const service = new IngestionService();
    vi.mocked(importSessionService.lockOwnedSessions).mockResolvedValue([{
      id: 'session-1',
      userId: 'user-1',
      libraryId: 'library-1',
      status: 'ready_for_review',
      originalFilename: 'Dragon.zip',
      draftMetadata: { modelName: 'Draft name' },
    }] as never);
    vi.mocked(modelService.createModel).mockResolvedValue({ id: 'model-1' } as never);
    vi.mocked(jobService.enqueueCommitJob).mockResolvedValue('job-1');

    await service.handleCommit(
      'session-1',
      { modelName: 'Explicit name' },
      'user-1',
      'library-1',
    );

    expect(modelService.createModel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Explicit name' }),
      databaseMocks.tx,
    );
    expect(jobService.enqueueCommitJob).toHaveBeenCalledWith(expect.objectContaining({
      batchMetadata: { modelName: 'Explicit name' },
    }));
  });

  it('rejects invalid effective metadata before creating or enqueueing a model', async () => {
    const service = new IngestionService();
    vi.mocked(importSessionService.lockOwnedSessions).mockResolvedValue([{
      id: 'session-1',
      userId: 'user-1',
      libraryId: 'library-1',
      status: 'ready_for_review',
      originalFilename: 'Dragon.zip',
      draftMetadata: { metadata: { year: 'not-a-number' } },
    }] as never);
    vi.mocked(metadataService.getFieldBySlug).mockResolvedValue({
      slug: 'year', type: 'number',
    } as never);
    vi.mocked(metadataService.validateFieldValue).mockImplementation(() => {
      throw validationError('Value must be a finite number', 'year');
    });

    await expect(service.handleCommit(
      'session-1', undefined, 'user-1', 'library-1',
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(modelService.createModel).not.toHaveBeenCalled();
    expect(importSessionService.update).not.toHaveBeenCalled();
    expect(jobService.enqueueCommitJob).not.toHaveBeenCalled();
  });
});

describe('IngestionService – processIngestionJob', () => {
  let service: IngestionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new IngestionService();
  });

  it('should set model to error state when pipeline fails', async () => {
    vi.mocked(fileProcessingService.processArchive).mockRejectedValue(new Error('corrupt zip'));
    vi.mocked(modelService.updateModelStatus).mockResolvedValue(undefined);

    const job = makeJob();

    await expect(
      service.processIngestionJob('job-1', 'model-1', '/tmp/bad.zip', 'user-1', job),
    ).rejects.toThrow('corrupt zip');

    // Must update the model to 'error' when the pipeline throws
    expect(modelService.updateModelStatus).toHaveBeenCalledWith('model-1', 'error');
  });

  it('should update model to ready state when pipeline succeeds', async () => {
    const manifest = makeManifest([]);
    vi.mocked(fileProcessingService.processArchive).mockResolvedValue(manifest);
    vi.mocked(modelService.createModelFiles).mockResolvedValue([]);
    vi.mocked(modelService.createThumbnails).mockResolvedValue(undefined);
    vi.mocked(modelService.updateModelStatus).mockResolvedValue(undefined);

    const job = makeJob();

    await service.processIngestionJob('job-1', 'model-1', '/tmp/model.zip', 'user-1', job);

    // Final status update must set model to 'ready'
    expect(modelService.updateModelStatus).toHaveBeenCalledWith(
      'model-1',
      'ready',
      expect.objectContaining({
        totalSizeBytes: 0,
        fileCount: 0,
      }),
    );
  });

  it('should report progress through the pipeline steps', async () => {
    const manifest = makeManifest([]);
    vi.mocked(fileProcessingService.processArchive).mockResolvedValue(manifest);
    vi.mocked(modelService.createModelFiles).mockResolvedValue([]);
    vi.mocked(modelService.createThumbnails).mockResolvedValue(undefined);
    vi.mocked(modelService.updateModelStatus).mockResolvedValue(undefined);

    const job = makeJob();

    await service.processIngestionJob('job-1', 'model-1', '/tmp/model.zip', 'user-1', job);

    // Progress calls: 0, 20, 50, 75, 100
    expect(job.updateProgress).toHaveBeenCalledWith(0);
    expect(job.updateProgress).toHaveBeenCalledWith(20);
    expect(job.updateProgress).toHaveBeenCalledWith(50);
    expect(job.updateProgress).toHaveBeenCalledWith(75);
    expect(job.updateProgress).toHaveBeenCalledWith(100);
  });
});

describe('IngestionService – staged commit progress', () => {
  let service: IngestionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new IngestionService();
    vi.mocked(importSessionService.getRow).mockResolvedValue({
      id: 'session-1',
      stagingPath: '/staging',
      manifest: {
        entries: [{
          filename: 'model.stl',
          relativePath: 'model.stl',
          fileType: 'stl',
          mimeType: 'model/stl',
          sizeBytes: 100,
          hash: 'hash',
        }],
        totalSizeBytes: 100,
      },
    } as never);
    vi.mocked(fileProcessingService.copyManifestToStorage).mockImplementation(
      async (_stagingPath, _modelId, _manifest, _storage, onProgress) => {
        await onProgress?.({
          completedFiles: 0,
          totalFiles: 1,
          completedBytes: 50,
          totalBytes: 100,
          currentFilename: 'model.stl',
        });
        await onProgress?.({
          completedFiles: 1,
          totalFiles: 1,
          completedBytes: 100,
          totalBytes: 100,
          currentFilename: 'model.stl',
        });
      },
    );
    vi.mocked(modelService.createModelFiles).mockResolvedValue([
      { id: 'file-1', fileType: 'stl' },
    ] as never);
    vi.mocked(modelService.updateModelStatus).mockResolvedValue(undefined);
    vi.mocked(importSessionService.update).mockResolvedValue(undefined);
  });

  it('should publish exact storage counters and ordered commit phases', async () => {
    const updateProgress = vi.fn().mockResolvedValue(undefined);
    const job = {
      id: 'session-1',
      data: {
        sessionId: 'session-1',
        modelId: 'model-1',
        userId: 'user-1',
        libraryId: 'library-1',
      },
      updateProgress,
      opts: { attempts: 1 },
      attemptsMade: 0,
      failedReason: null,
    };

    await service.processCommitJob(job as never);

    const progress = updateProgress.mock.calls.map(([value]) => value);
    expect(progress.map((value) => value.phase)).toEqual([
      'queued',
      'storing_files',
      'storing_files',
      'saving_records',
      'generating_thumbnails',
      'applying_metadata',
      'complete',
    ]);
    expect(progress[1]).toEqual(expect.objectContaining({
      percent: 40,
      completedFiles: 0,
      completedBytes: 50,
      currentFilename: 'model.stl',
    }));
    expect(progress.at(-1)).toEqual(expect.objectContaining({
      percent: 100,
      completedFiles: 1,
      completedBytes: 100,
      currentFilename: null,
    }));
  });

  it('should complete the model when BullMQ progress persistence fails', async () => {
    const job = {
      id: 'session-1',
      data: {
        sessionId: 'session-1',
        modelId: 'model-1',
        userId: 'user-1',
        libraryId: 'library-1',
      },
      updateProgress: vi.fn().mockRejectedValue(new Error('Redis progress failed')),
      opts: { attempts: 1 },
      attemptsMade: 0,
      failedReason: null,
    };

    await expect(service.processCommitJob(job as never)).resolves.toBeUndefined();
    expect(modelService.updateModelStatus).toHaveBeenCalledWith('model-1', 'ready', {
      totalSizeBytes: 100,
      fileCount: 1,
    });
    expect(importSessionService.update).toHaveBeenCalledWith('session-1', {
      status: 'committed',
    });
  });

  it('applies configured metadata with dedicated artist/tags taking precedence', async () => {
    const job = {
      id: 'session-1',
      data: {
        sessionId: 'session-1',
        modelId: 'model-1',
        userId: 'user-1',
        libraryId: 'library-1',
        batchMetadata: {
          artist: 'Reviewed Artist',
          tags: ['reviewed'],
          metadata: {
            source: 'Konosuba',
            year: 2024,
            artist: 'Generic Artist',
            tags: ['generic'],
          },
        },
      },
      updateProgress: vi.fn().mockResolvedValue(undefined),
      opts: { attempts: 1 },
      attemptsMade: 0,
      failedReason: null,
    };

    await service.processCommitJob(job as never);

    expect(metadataService.setModelMetadata).toHaveBeenCalledWith('model-1', {
      source: 'Konosuba',
      year: 2024,
      artist: 'Reviewed Artist',
      tags: ['reviewed'],
    });
  });
});

describe('IngestionService – multipart scan orchestration', () => {
  let service: IngestionService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fileProcessingService.validateMultipartArchives).mockReset();
    vi.mocked(fileProcessingService.validateMultipartArchives).mockReturnValue('model-a.zip');
    service = new IngestionService();
  });

  it('creates one import session and carries the archive group into one scan job', async () => {
    const files = [
      { tempFilePath: '/tmp/model-a.zip', originalFilename: 'model-a.zip' },
      { tempFilePath: '/tmp/model-b.zip', originalFilename: 'model-b.zip' },
    ];
    vi.mocked(importSessionService.create).mockResolvedValue({ id: 'session-1' });
    vi.mocked(jobService.enqueueScanJob).mockResolvedValue('job-1');

    await expect(service.handleMultipartScan(
      files,
      'combine',
      'user-1',
      'library-1',
    )).resolves.toEqual({ sessionId: 'session-1' });

    expect(fileProcessingService.validateMultipartArchives).toHaveBeenCalledWith(files, 'combine');
    expect(importSessionService.create).toHaveBeenCalledOnce();
    expect(jobService.enqueueScanJob).toHaveBeenCalledWith({
      sessionId: 'session-1',
      tempFilePath: '/tmp/model-a.zip',
      originalFilename: 'model-a.zip',
      userId: 'user-1',
      libraryId: 'library-1',
      multipart: { files, mode: 'combine' },
    });
    expect(fsPromises.rm).not.toHaveBeenCalled();
  });

  it('uses the canonical split filename for the session and scan job', async () => {
    const files = [
      { tempFilePath: '/tmp/dragon-part-2', originalFilename: 'DRAGON.ZIP.002' },
      { tempFilePath: '/tmp/dragon-part-1', originalFilename: 'Dragon.Zip.001' },
    ];
    vi.mocked(fileProcessingService.validateMultipartArchives).mockReturnValue('Dragon.Zip');
    vi.mocked(importSessionService.create).mockResolvedValue({ id: 'session-1' });
    vi.mocked(jobService.enqueueScanJob).mockResolvedValue('job-1');

    await service.handleMultipartScan(files, 'split', 'user-1', 'library-1');

    expect(importSessionService.create).toHaveBeenCalledWith({
      userId: 'user-1',
      libraryId: 'library-1',
      originalFilename: 'Dragon.Zip',
    });
    expect(jobService.enqueueScanJob).toHaveBeenCalledWith(
      expect.objectContaining({ originalFilename: 'Dragon.Zip' }),
    );
  });

  it('reports one detected model for a multipart session while retaining folder preview', async () => {
    const files = [
      { tempFilePath: '/tmp/a.zip', originalFilename: 'a.zip' },
      { tempFilePath: '/tmp/b.zip', originalFilename: 'b.zip' },
    ];
    vi.mocked(fileProcessingService.processMultipartArchives).mockResolvedValue({
      entries: [
        { filename: 'a.stl', relativePath: 'a/a.stl', fileType: 'stl', mimeType: 'model/stl', sizeBytes: 1, hash: 'a' },
        { filename: 'b.stl', relativePath: 'b/b.stl', fileType: 'stl', mimeType: 'model/stl', sizeBytes: 1, hash: 'b' },
      ],
      totalSizeBytes: 2,
    });

    await service.processScanJob(
      'session-1',
      files[0].tempFilePath,
      'a.zip',
      'library-1',
      { files, mode: 'combine' },
    );

    expect(importSessionService.update).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        detected: expect.objectContaining({
          modelCount: 1,
          folderStructure: expect.arrayContaining([
            expect.objectContaining({ name: 'a', type: 'folder' }),
            expect.objectContaining({ name: 'b', type: 'folder' }),
          ]),
        }),
      }),
    );
  });

  it('cleans every assembled member when multipart validation fails', async () => {
    const files = [
      { tempFilePath: '/tmp/model.z01', originalFilename: 'model.z01' },
      { tempFilePath: '/tmp/other.zip', originalFilename: 'other.zip' },
    ];
    vi.mocked(fileProcessingService.validateMultipartArchives).mockImplementation(() => {
      throw new Error('unrelated split parts');
    });

    await expect(service.handleMultipartScan(
      files,
      'split',
      'user-1',
      'library-1',
    )).rejects.toThrow('unrelated split parts');

    expect(importSessionService.create).not.toHaveBeenCalled();
    expect(fsPromises.rm).toHaveBeenCalledWith('/tmp/model.z01', { force: true });
    expect(fsPromises.rm).toHaveBeenCalledWith('/tmp/other.zip', { force: true });
  });

  it('cleans every assembled member when enqueueing the multipart scan fails', async () => {
    const files = [
      { tempFilePath: '/tmp/model-a.zip', originalFilename: 'model-a.zip' },
      { tempFilePath: '/tmp/model-b.zip', originalFilename: 'model-b.zip' },
    ];
    vi.mocked(importSessionService.create).mockResolvedValue({ id: 'session-1' });
    vi.mocked(jobService.enqueueScanJob).mockRejectedValue(new Error('queue unavailable'));

    await expect(service.handleMultipartScan(
      files,
      'combine',
      'user-1',
      'library-1',
    )).rejects.toThrow('queue unavailable');

    expect(importSessionService.update).toHaveBeenCalledWith('session-1', {
      status: 'error',
      error: 'Failed to start scan',
    });
    expect(fsPromises.rm).toHaveBeenCalledWith('/tmp/model-a.zip', { force: true });
    expect(fsPromises.rm).toHaveBeenCalledWith('/tmp/model-b.zip', { force: true });
  });

  it('does not persist an internal ENOENT path when multipart extraction fails', async () => {
    const files = [
      { tempFilePath: '/tmp/model.z01', originalFilename: 'model.z01' },
      { tempFilePath: '/tmp/model.zip', originalFilename: 'model.zip' },
    ];
    vi.mocked(fileProcessingService.processMultipartArchives)
      .mockRejectedValue(Object.assign(
        new Error("ENOENT: no such file or directory, open '/tmp/upload_private_part2.rar'"),
        { code: 'ENOENT' },
      ));

    await expect(service.processScanJob(
      'session-1',
      files[0].tempFilePath,
      files[0].originalFilename,
      'library-1',
      { files, mode: 'split' },
    )).resolves.toBeUndefined();

    expect(importSessionService.update).toHaveBeenCalledWith('session-1', {
      status: 'error',
      error: 'Could not process this archive',
    });
    expect(fsPromises.rm).toHaveBeenCalledWith(
      '/tmp/model.z01_extracted',
      { recursive: true, force: true },
    );
    expect(fsPromises.rm).toHaveBeenCalledWith('/tmp/model.z01', { force: true });
    expect(fsPromises.rm).toHaveBeenCalledWith('/tmp/model.zip', { force: true });
  });

  it('persists actionable validation guidance when multipart extraction is rejected', async () => {
    const files = [
      { tempFilePath: '/tmp/model.part1.rar', originalFilename: 'model.part1.rar' },
      { tempFilePath: '/tmp/model.part3.rar', originalFilename: 'model.part3.rar' },
    ];
    vi.mocked(fileProcessingService.processMultipartArchives).mockRejectedValue(
      validationError('Split RAR set is missing part 2'),
    );

    await expect(service.processScanJob(
      'session-1',
      files[0].tempFilePath,
      files[0].originalFilename,
      'library-1',
      { files, mode: 'split' },
    )).resolves.toBeUndefined();

    expect(importSessionService.update).toHaveBeenCalledWith('session-1', {
      status: 'error',
      error: 'Split RAR set is missing part 2',
    });
  });
});

describe('IngestionService – extractModelArchive', () => {
  let service: IngestionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new IngestionService();
  });

  it('extracts archive contents into a sibling folder and updates model stats', async () => {
    vi.mocked(modelService.requireOwnedModel).mockResolvedValue({ id: 'model-1' } as never);
    vi.mocked(modelService.getModelFiles).mockResolvedValue([
      {
        id: 'archive-1',
        modelId: 'model-1',
        filename: 'alternate-parts.zip',
        relativePath: 'extras/alternate-parts.zip',
        fileType: 'other',
        mimeType: 'application/zip',
        sizeBytes: 100,
        storagePath: 'models/model-1/extras/alternate-parts.zip',
        hash: 'archive-hash',
        createdAt: new Date(),
      },
    ]);
    vi.mocked(modelService.getModelFolders).mockResolvedValue([]);
    vi.mocked(fileProcessingService.processArchive).mockResolvedValue({
      entries: [
        {
          filename: 'mesh.stl',
          relativePath: 'parts/mesh.stl',
          fileType: 'stl',
          mimeType: 'model/stl',
          sizeBytes: 42,
          hash: 'mesh-hash',
        },
      ],
      totalSizeBytes: 42,
    });
    vi.mocked(modelService.createModelFiles).mockResolvedValue([{ id: 'file-1', fileType: 'stl' }]);
    vi.mocked(modelService.recalculateModelStats).mockResolvedValue(undefined);

    const result = await service.extractModelArchive(
      'model-1',
      'archive-1',
      'user-1',
      'library-1',
    );

    expect(result).toEqual({
      addedFileCount: 1,
      destinationPath: 'extras/alternate-parts',
    });
    expect(storageService.store).toHaveBeenCalledWith(
      'models/model-1/extras/alternate-parts/parts/mesh.stl',
      expect.anything(),
    );
    expect(modelService.createModelFiles).toHaveBeenCalledWith(
      'model-1',
      [expect.objectContaining({ relativePath: 'extras/alternate-parts/parts/mesh.stl' })],
    );
    expect(modelService.recalculateModelStats).toHaveBeenCalledWith('model-1');
  });
});

describe('IngestionService – extractSessionArchive', () => {
  let service: IngestionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new IngestionService();
  });

  it('rescans staged files after extracting a nested archive', async () => {
    const sessionRow = {
      id: 'session-1',
      userId: 'user-1',
      libraryId: 'library-1',
      originalFilename: 'model-pack.zip',
      status: 'ready_for_review',
      stagingPath: '/staging',
      manifest: {
        entries: [
          {
            filename: 'parts.zip',
            relativePath: 'extras/parts.zip',
            fileType: 'other' as const,
            mimeType: 'application/zip',
            sizeBytes: 100,
            hash: 'archive-hash',
          },
        ],
        totalSizeBytes: 100,
      },
    };
    vi.mocked(importSessionService.getOwnedRow).mockResolvedValue(sessionRow as never);
    vi.mocked(importSessionService.update).mockResolvedValue(undefined);
    vi.mocked(importSessionService.toDto).mockReturnValue({ id: 'session-1' } as never);
    vi.mocked(fileProcessingService.processArchive).mockResolvedValue(makeManifest([]));
    vi.mocked(fileProcessingService.scanDirectory).mockResolvedValue([
      ...sessionRow.manifest.entries,
      {
        filename: 'mesh.stl',
        relativePath: 'extras/parts/mesh.stl',
        fileType: 'stl' as const,
        mimeType: 'model/stl',
        sizeBytes: 42,
        hash: 'mesh-hash',
      },
    ]);

    await service.extractSessionArchive(
      'session-1',
      'extras/parts.zip',
      'user-1',
      'library-1',
    );

    expect(fileProcessingService.processArchive).toHaveBeenCalledWith(
      '/staging/extras/parts.zip',
      '/staging/extras/parts',
    );
    expect(importSessionService.update).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        manifest: expect.objectContaining({ totalSizeBytes: 142 }),
        detected: expect.objectContaining({
          fileCount: 2,
          archives: [
            expect.objectContaining({ relativePath: 'extras/parts.zip' }),
          ],
        }),
      }),
    );
  });
});

describe('IngestionService – remote folder import', () => {
  const sourcePath = '/imports/model-one/model.stl';
  const contents = Buffer.from('verified model contents');
  const hash = createHash('sha256').update(contents).digest('hex');
  let service: IngestionService;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(storageService, 'kind', { value: 's3', configurable: true });
    service = new IngestionService();
    vi.mocked(fileProcessingService.walkDirectoryForImport).mockResolvedValue([
      {
        name: 'Model One',
        sourcePath: '/imports/model-one',
        collectionName: null,
        metadata: {},
      },
    ]);
    vi.mocked(fileProcessingService.scanDirectory).mockResolvedValue([
      {
        filename: 'model.stl',
        relativePath: 'model.stl',
        fileType: 'stl',
        mimeType: 'model/stl',
        sizeBytes: contents.length,
        hash,
      },
    ]);
    vi.mocked(modelService.createModel).mockResolvedValue({ id: 'model-1' } as never);
    vi.mocked(modelService.createModelFiles).mockResolvedValue([
      { id: 'file-1', fileType: 'stl' },
    ] as never);
    vi.mocked(modelService.updateModelStatus).mockResolvedValue(undefined);
    // A real backend consumes the body it is handed, which is what advances the
    // streaming hash behind `storeVerified`. A mock that ignores it would make
    // every upload look like zero bytes.
    vi.mocked(storageService.store).mockImplementation(async (_path, data) => {
      if (!Buffer.isBuffer(data)) {
        for await (const _chunk of data) {
          // drain
        }
      }
      return {};
    });
    vi.mocked(storageService.delete).mockResolvedValue(undefined);
    fsMocks.createReadStream.mockImplementation(() => Readable.from(contents));
  });

  afterEach(() => {
    Object.defineProperty(storageService, 'kind', { value: 'local', configurable: true });
  });

  it('deletes move sources only after the uploaded object is verified', async () => {
    vi.mocked(storageService.retrieveStream).mockResolvedValue(Readable.from(contents));

    await service.processFolderImportJob({
      id: 'job-1',
      data: {
        sourcePath: '/imports',
        pattern: '{model}',
        strategy: 'move',
        deleteAfterUpload: true,
        userId: 'user-1',
        libraryId: 'library-1',
      },
      updateProgress: vi.fn().mockResolvedValue(undefined),
    } as never);

    expect(storageService.store).toHaveBeenCalledWith(
      'models/model-1/model.stl',
      expect.anything(),
      undefined,
    );
    // Verification now rides along with the upload, so the object is never
    // fetched back to be hashed.
    expect(storageService.retrieveStream).not.toHaveBeenCalledWith('models/model-1/model.stl');
    expect(fsPromises.unlink).toHaveBeenCalledWith(sourcePath);
    expect(modelService.updateModelStatus).toHaveBeenCalledWith('model-1', 'ready', {
      totalSizeBytes: contents.length,
      fileCount: 1,
    });
  });

  it('cleans up an unverifiable object and preserves its source', async () => {
    // The bytes actually read no longer hash to what the scan recorded.
    fsMocks.createReadStream.mockImplementation(() =>
      Readable.from(Buffer.from('corrupted contents')),
    );

    await service.processFolderImportJob({
      id: 'job-1',
      data: {
        sourcePath: '/imports',
        pattern: '{model}',
        strategy: 'move',
        deleteAfterUpload: true,
        userId: 'user-1',
        libraryId: 'library-1',
      },
      updateProgress: vi.fn().mockResolvedValue(undefined),
    } as never);

    expect(storageService.delete).toHaveBeenCalledWith('models/model-1/model.stl');
    expect(fsPromises.unlink).not.toHaveBeenCalled();
    expect(modelService.updateModelStatus).toHaveBeenCalledWith('model-1', 'error');
  });

  it('cleans up verified objects when a later persistence step fails', async () => {
    vi.mocked(modelService.createModelFiles).mockRejectedValue(new Error('database unavailable'));

    await service.processFolderImportJob({
      id: 'job-1',
      data: {
        sourcePath: '/imports',
        pattern: '{model}',
        strategy: 'move',
        deleteAfterUpload: true,
        userId: 'user-1',
        libraryId: 'library-1',
      },
      updateProgress: vi.fn().mockResolvedValue(undefined),
    } as never);

    expect(storageService.delete).toHaveBeenCalledWith('models/model-1/model.stl');
    expect(fsPromises.unlink).not.toHaveBeenCalled();
    expect(modelService.updateModelStatus).toHaveBeenCalledWith('model-1', 'error');
  });

  it('retains managed objects after file rows have been persisted', async () => {
    vi.mocked(storageService.retrieveStream).mockResolvedValue(Readable.from(contents));
    vi.mocked(fileProcessingService.walkDirectoryForImport).mockResolvedValueOnce([
      {
        name: 'Model One',
        sourcePath: '/imports/model-one',
        collectionName: null,
        metadata: { artist: 'Artist' },
      },
    ]);
    vi.mocked(metadataService.setModelMetadata).mockRejectedValue(
      new Error('metadata persistence failed'),
    );

    await service.processFolderImportJob({
      id: 'job-1',
      data: {
        sourcePath: '/imports',
        pattern: '{model}',
        strategy: 'move',
        deleteAfterUpload: true,
        userId: 'user-1',
        libraryId: 'library-1',
      },
      updateProgress: vi.fn().mockResolvedValue(undefined),
    } as never);

    expect(storageService.delete).not.toHaveBeenCalled();
    expect(fsPromises.unlink).not.toHaveBeenCalled();
    expect(modelService.updateModelStatus).toHaveBeenCalledWith('model-1', 'error');
  });

  it('retains a source that changes after its remote object was verified', async () => {
    vi.mocked(storageService.retrieveStream).mockResolvedValue(Readable.from(contents));
    fsMocks.createReadStream
      .mockReturnValueOnce(Readable.from(contents))
      .mockReturnValueOnce(Readable.from(Buffer.from('changed source')));

    await service.processFolderImportJob({
      id: 'job-1',
      data: {
        sourcePath: '/imports',
        pattern: '{model}',
        strategy: 'move',
        deleteAfterUpload: true,
        userId: 'user-1',
        libraryId: 'library-1',
      },
      updateProgress: vi.fn().mockResolvedValue(undefined),
    } as never);

    expect(fsPromises.unlink).not.toHaveBeenCalled();
    expect(modelService.createModel).toHaveBeenCalledTimes(1);
  });

  it('does not retry the completed import when source deletion fails', async () => {
    vi.mocked(storageService.retrieveStream).mockResolvedValue(Readable.from(contents));
    vi.mocked(fsPromises.unlink).mockRejectedValue(new Error('source is read-only'));

    await expect(service.processFolderImportJob({
      id: 'job-1',
      data: {
        sourcePath: '/imports',
        pattern: '{model}',
        strategy: 'move',
        deleteAfterUpload: true,
        userId: 'user-1',
        libraryId: 'library-1',
      },
      updateProgress: vi.fn().mockResolvedValue(undefined),
    } as never)).resolves.toBeUndefined();

    expect(modelService.createModel).toHaveBeenCalledTimes(1);
  });

  it('maps move requests to verified source deletion', async () => {
    vi.mocked(jobService.enqueueFolderImportJob).mockResolvedValue('job-1');

    await service.handleFolderImport(
      { sourcePath: '/imports', pattern: '{model}', strategy: 'move' },
      'user-1',
      'library-1',
    );

    expect(jobService.enqueueFolderImportJob).toHaveBeenCalledWith(
      expect.objectContaining({ deleteAfterUpload: true }),
    );
  });
});

describe('IngestionService – appendFilesToSession', () => {
  let service: IngestionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new IngestionService();
  });

  it('adds loose files with collision-safe names and refreshes detected metadata', async () => {
    const sessionRow = {
      id: 'session-1',
      userId: 'user-1',
      libraryId: 'library-1',
      originalFilename: 'model-pack.zip',
      status: 'ready_for_review',
      stagingPath: '/staging',
      manifest: {
        entries: [
          {
            filename: 'render.png',
            relativePath: 'render.png',
            fileType: 'image' as const,
            mimeType: 'image/png',
            sizeBytes: 100,
            hash: 'old-render-hash',
          },
        ],
        totalSizeBytes: 100,
      },
    };
    const rescannedEntries = [
      ...sessionRow.manifest.entries,
      {
        filename: 'render (2).png',
        relativePath: 'render (2).png',
        fileType: 'image' as const,
        mimeType: 'image/png',
        sizeBytes: 50,
        hash: 'new-render-hash',
      },
    ];
    vi.mocked(importSessionService.getOwnedRow).mockResolvedValue(sessionRow as never);
    vi.mocked(importSessionService.update).mockResolvedValue(undefined);
    vi.mocked(importSessionService.toDto).mockReturnValue({ id: 'session-1' } as never);
    vi.mocked(fileProcessingService.scanDirectory).mockResolvedValue(rescannedEntries);

    await service.appendFilesToSession(
      [{ tempFilePath: '/tmp/new-render', originalFilename: 'render.png' }],
      'session-1',
      'user-1',
      'library-1',
    );

    expect(fsPromises.copyFile).toHaveBeenCalledWith(
      '/tmp/new-render',
      '/staging/render (2).png',
    );
    expect(importSessionService.update).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        manifest: expect.objectContaining({ totalSizeBytes: 150 }),
        detected: expect.objectContaining({
          fileCount: 2,
          previewImages: expect.arrayContaining([
            expect.objectContaining({ relativePath: 'render (2).png' }),
          ]),
        }),
      }),
    );
    expect(fsPromises.rm).toHaveBeenCalledWith('/tmp/new-render', { force: true });
  });
});
