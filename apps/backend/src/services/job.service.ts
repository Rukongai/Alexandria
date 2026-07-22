import { Queue } from 'bullmq';
import type {
  ImportCommitProgress,
  ImportStrategy,
  BatchUploadMetadata,
  MultipartArchiveMode,
} from '@alexandria/shared';
import { config } from '../config/index.js';
import { parseRedisUrl } from '../utils/redis.js';

export interface IngestionJobPayload {
  modelId: string;
  tempFilePath: string;
  originalFilename: string;
  userId: string;
  /** Library the model belongs to. Captured at upload time from request.libraryId. */
  libraryId: string;
}

export interface FolderImportJobPayload {
  sourcePath: string;
  pattern: string;
  strategy: ImportStrategy;
  /** Remote storage only: remove sources after every uploaded object is verified. */
  deleteAfterUpload: boolean;
  userId: string;
  /** Library to create models/collections in. Captured at import-request time from request.libraryId. */
  libraryId: string;
}

/** Scan phase of a staged upload: extract + detect, no commit. */
export interface ScanJobPayload {
  sessionId: string;
  tempFilePath: string;
  originalFilename: string;
  userId: string;
  libraryId: string;
  /** Present for explicitly grouped archives. Absent on legacy/single-file jobs. */
  multipart?: {
    files: Array<{ tempFilePath: string; originalFilename: string }>;
    mode: MultipartArchiveMode;
  };
}

/** Commit phase of a staged upload: persist files + apply batch metadata. */
export interface CommitJobPayload {
  sessionId: string;
  modelId: string;
  userId: string;
  libraryId: string;
  batchMetadata?: BatchUploadMetadata;
}

const INGESTION_QUEUE = 'ingestion';
const IMPORT_QUEUE = 'folder-import';
const IMPORT_SCAN_QUEUE = 'import-scan';
const IMPORT_COMMIT_QUEUE = 'import-commit';

export class JobService {
  private readonly ingestionQueue: Queue;
  private readonly importQueue: Queue;
  private readonly importScanQueue: Queue;
  private readonly importCommitQueue: Queue;

  constructor() {
    const connection = parseRedisUrl(config.redisUrl);
    const defaultJobOptions = {
      attempts: 3,
      backoff: {
        type: 'exponential' as const,
        delay: 1000,
      },
    };

    this.ingestionQueue = new Queue(INGESTION_QUEUE, { connection, defaultJobOptions });
    this.importQueue = new Queue(IMPORT_QUEUE, { connection, defaultJobOptions });
    // Scan runs once — a corrupt archive won't fix itself on retry.
    this.importScanQueue = new Queue(IMPORT_SCAN_QUEUE, {
      connection,
      defaultJobOptions: { attempts: 1 },
    });
    // Commit also runs once — retrying processCommitJob re-runs createModelFiles,
    // which produces duplicate ModelFile rows and double-counts totalSizeBytes.
    // Idempotent retry support is deferred; for now, attempts: 1 prevents duplication.
    this.importCommitQueue = new Queue(IMPORT_COMMIT_QUEUE, {
      connection,
      defaultJobOptions: { attempts: 1 },
    });
  }

  async enqueueIngestionJob(payload: IngestionJobPayload): Promise<string> {
    const job = await this.ingestionQueue.add('process', payload);
    return job.id!;
  }

  async enqueueFolderImportJob(payload: FolderImportJobPayload): Promise<string> {
    const job = await this.importQueue.add('import', payload);
    return job.id!;
  }

  async enqueueScanJob(payload: ScanJobPayload): Promise<string> {
    const job = await this.importScanQueue.add('scan', payload);
    return job.id!;
  }

  async enqueueCommitJob(payload: CommitJobPayload): Promise<string> {
    const job = await this.importCommitQueue.add('commit', payload, {
      jobId: payload.sessionId,
    });
    return job.id!;
  }

  async getImportCommitProgress(sessionId: string): Promise<ImportCommitProgress | null> {
    const job = await this.importCommitQueue.getJob(sessionId);
    return parseImportCommitProgress(job?.progress);
  }

  async getJobStatus(
    jobId: string,
  ): Promise<{ status: string; progress: number | null; error: string | null }> {
    // Check both queues
    const job =
      (await this.ingestionQueue.getJob(jobId)) ??
      (await this.importQueue.getJob(jobId));

    if (!job) {
      return { status: 'unknown', progress: null, error: null };
    }

    const state = await job.getState();
    const progress = typeof job.progress === 'number' ? job.progress : null;
    const error = job.failedReason ?? null;

    return { status: state, progress, error };
  }

  get folderImportQueueName(): string {
    return IMPORT_QUEUE;
  }

  get importScanQueueName(): string {
    return IMPORT_SCAN_QUEUE;
  }

  get importCommitQueueName(): string {
    return IMPORT_COMMIT_QUEUE;
  }
}

export const jobService = new JobService();

const IMPORT_COMMIT_PHASES = new Set<ImportCommitProgress['phase']>([
  'queued',
  'storing_files',
  'saving_records',
  'generating_thumbnails',
  'applying_metadata',
  'complete',
]);

export function parseImportCommitProgress(value: unknown): ImportCommitProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const candidate = value as Partial<ImportCommitProgress>;
  if (
    !IMPORT_COMMIT_PHASES.has(candidate.phase as ImportCommitProgress['phase']) ||
    !isIntegerBetween(candidate.percent, 0, 100) ||
    !isNonNegativeSafeInteger(candidate.completedFiles) ||
    !isNonNegativeSafeInteger(candidate.totalFiles) ||
    candidate.completedFiles > candidate.totalFiles ||
    !isNonNegativeSafeInteger(candidate.completedBytes) ||
    !isNonNegativeSafeInteger(candidate.totalBytes) ||
    candidate.completedBytes > candidate.totalBytes ||
    (candidate.currentFilename !== null && typeof candidate.currentFilename !== 'string')
  ) {
    return null;
  }

  return candidate as ImportCommitProgress;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIntegerBetween(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}
