import { Queue } from 'bullmq';
import type { ImportStrategy, BatchUploadMetadata } from '@alexandria/shared';
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
    // Scan runs once (no retry — a corrupt archive won't fix itself); commit retries.
    this.importScanQueue = new Queue(IMPORT_SCAN_QUEUE, {
      connection,
      defaultJobOptions: { attempts: 1 },
    });
    this.importCommitQueue = new Queue(IMPORT_COMMIT_QUEUE, { connection, defaultJobOptions });
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
    const job = await this.importCommitQueue.add('commit', payload);
    return job.id!;
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
