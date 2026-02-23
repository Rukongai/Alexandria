import { Worker, type Job } from 'bullmq';
import { config } from '../config/index.js';
import { ingestionService } from '../services/ingestion.service.js';
import type { IngestionJobPayload } from '../services/job.service.js';
import { parseRedisUrl } from '../utils/redis.js';
import { createLogger } from '../utils/logger.js';

const QUEUE_NAME = 'ingestion';
const logger = createLogger('IngestionWorker');

let worker: Worker | null = null;

export function startIngestionWorker(): void {
  const connection = parseRedisUrl(config.redisUrl);

  worker = new Worker(
    QUEUE_NAME,
    async (job: Job<IngestionJobPayload>) => {
      const { modelId, tempFilePath, userId } = job.data;

      logger.info({ jobId: job.id, modelId }, 'Ingestion job started');

      await ingestionService.processIngestionJob(
        job.id!,
        modelId,
        tempFilePath,
        userId,
        job,
      );

      logger.info({ jobId: job.id, modelId }, 'Ingestion job completed');
    },
    {
      connection,
      concurrency: 2,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, modelId: job?.data?.modelId, error: err.message },
      'Ingestion job failed',
    );
  });
}

export function stopIngestionWorker(): Promise<void> {
  return worker ? worker.close() : Promise.resolve();
}
