import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  },
  JobService: vi.fn(),
}));

vi.mock('./file-processing.service.js', () => ({
  fileProcessingService: {
    processArchive: vi.fn(),
    scanDirectory: vi.fn(),
    copyManifestToStorage: vi.fn().mockResolvedValue(undefined),
  },
  FileProcessingService: vi.fn(),
}));

vi.mock('./import-session.service.js', () => ({
  importSessionService: {
    getOwnedRow: vi.fn(),
    update: vi.fn(),
    toDto: vi.fn(),
  },
  ImportSessionService: vi.fn(),
}));

vi.mock('./metadata.service.js', () => ({
  metadataService: {
    listFieldValues: vi.fn().mockResolvedValue([]),
  },
  MetadataService: vi.fn(),
}));

vi.mock('./thumbnail.service.js', () => ({
  thumbnailService: {
    generateThumbnails: vi.fn(),
  },
  ThumbnailService: vi.fn(),
}));

vi.mock('./storage.service.js', () => ({
  storageService: {
    store: vi.fn(),
    delete: vi.fn(),
    resolveStoragePath: vi.fn(),
  },
  StorageService: vi.fn(),
}));

// node:fs is used for createReadStream inside processIngestionJob
vi.mock('node:fs', () => ({
  default: {
    createReadStream: vi.fn().mockReturnValue({ pipe: vi.fn() }),
  },
}));

// node:fs/promises is used for rm (cleanup)
vi.mock('node:fs/promises', () => ({
  default: {
    rm: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn().mockResolvedValue('/tmp/alexandria-extract-test'),
    copyFile: vi.fn().mockResolvedValue(undefined),
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
import fsPromises from 'node:fs/promises';

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
    vi.mocked(storageService.resolveStoragePath).mockReturnValue('/storage/alternate-parts.zip');
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
