import { Queue } from 'bullmq';
import { config } from '../config/index.js';
import { parseRedisUrl } from '../utils/redis.js';

export interface IngestionJobPayload {
  modelId: string;
  tempFilePath: string;
  originalFilename: string;
  userId: string;
}

const QUEUE_NAME = 'ingestion';

export class JobService {
  private readonly queue: Queue;

  constructor() {
    const connection = parseRedisUrl(config.redisUrl);
    this.queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      },
    });
  }

  async enqueueIngestionJob(payload: IngestionJobPayload): Promise<string> {
    const job = await this.queue.add('process', payload);
    return job.id!;
  }

  async getJobStatus(
    jobId: string,
  ): Promise<{ status: string; progress: number | null; error: string | null }> {
    const job = await this.queue.getJob(jobId);

    if (!job) {
      return { status: 'unknown', progress: null, error: null };
    }

    const state = await job.getState();
    const progress = typeof job.progress === 'number' ? job.progress : null;
    const error = job.failedReason ?? null;

    return { status: state, progress, error };
  }
}

export const jobService = new JobService();
