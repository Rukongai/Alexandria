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
    copyManifestToStorage: vi.fn().mockResolvedValue(undefined),
  },
  FileProcessingService: vi.fn(),
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
    getStorageRoot: vi.fn().mockReturnValue('/storage'),
    resolveModelPath: vi.fn().mockReturnValue('/storage/main-library/dragon-bust-a3f2'),
  },
  StorageService: vi.fn(),
}));

vi.mock('./library.service.js', () => ({
  libraryService: {
    getLibraryById: vi.fn().mockResolvedValue({
      id: 'lib-1',
      name: 'Main Library',
      slug: 'main-library',
      pathTemplate: '{library}/{model}',
      rootPath: '/storage',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  },
  LibraryService: vi.fn(),
}));

vi.mock('./metadata.service.js', () => ({
  metadataService: {
    setModelMetadata: vi.fn().mockResolvedValue(undefined),
    getModelMetadata: vi.fn().mockResolvedValue([]),
  },
  MetadataService: vi.fn(),
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
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------
import { IngestionService } from './ingestion.service.js';
import { modelService } from './model.service.js';
import { jobService } from './job.service.js';
import { fileProcessingService } from './file-processing.service.js';

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
      'lib-1',
    );

    // Returns both IDs
    expect(result).toEqual({ modelId: 'model-abc', jobId: 'job-xyz' });

    // Model created with status 'processing' and archive_upload source
    expect(modelService.createModel).toHaveBeenCalledOnce();
    expect(modelService.createModel).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'processing',
        sourceType: 'archive_upload',
        originalFilename: 'my-model.zip',
        userId: 'user-1',
      }),
    );

    // Job enqueued with correct payload
    expect(jobService.enqueueIngestionJob).toHaveBeenCalledOnce();
    expect(jobService.enqueueIngestionJob).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'model-abc',
        tempFilePath: '/tmp/upload.zip',
        originalFilename: 'my-model.zip',
        userId: 'user-1',
      }),
    );
  });

  it('should strip .zip extension from name when creating model', async () => {
    vi.mocked(modelService.createModel).mockResolvedValue({ id: 'model-abc' });
    vi.mocked(jobService.enqueueIngestionJob).mockResolvedValue('job-xyz');

    await service.handleUpload(
      { tempFilePath: '/tmp/upload.zip', originalFilename: 'Cool Model.zip' },
      'user-1',
      'lib-1',
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
      'lib-1',
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
      'lib-1',
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
      service.processIngestionJob('job-1', 'model-1', '/tmp/bad.zip', 'user-1', job, 'lib-1', 'model-1'),
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

    await service.processIngestionJob('job-1', 'model-1', '/tmp/model.zip', 'user-1', job, 'lib-1', 'model-1');

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

    await service.processIngestionJob('job-1', 'model-1', '/tmp/model.zip', 'user-1', job, 'lib-1', 'model-1');

    // Progress calls: 0, 20, 50, 75, 100
    expect(job.updateProgress).toHaveBeenCalledWith(0);
    expect(job.updateProgress).toHaveBeenCalledWith(20);
    expect(job.updateProgress).toHaveBeenCalledWith(50);
    expect(job.updateProgress).toHaveBeenCalledWith(75);
    expect(job.updateProgress).toHaveBeenCalledWith(100);
  });
});
