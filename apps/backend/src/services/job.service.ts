import { Queue } from 'bullmq';
import type { ImportStrategy } from '@alexandria/shared';
import { config } from '../config/index.js';
import { parseRedisUrl } from '../utils/redis.js';

export interface IngestionJobPayload {
  modelId: string;
  tempFilePath: string;
  originalFilename: string;
  userId: string;
}

export interface FolderImportJobPayload {
  sourcePath: string;
  pattern: string;
  strategy: ImportStrategy;
  userId: string;
}

const INGESTION_QUEUE = 'ingestion';
const IMPORT_QUEUE = 'folder-import';

export class JobService {
  private readonly ingestionQueue: Queue;
  private readonly importQueue: Queue;

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
  }

  async enqueueIngestionJob(payload: IngestionJobPayload): Promise<string> {
    const job = await this.ingestionQueue.add('process', payload);
    return job.id!;
  }

  async enqueueFolderImportJob(payload: FolderImportJobPayload): Promise<string> {
    const job = await this.importQueue.add('import', payload);
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
}

export const jobService = new JobService();
