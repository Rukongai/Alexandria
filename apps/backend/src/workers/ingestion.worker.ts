import { Worker, type Job } from 'bullmq';
import { config } from '../config/index.js';
import { ingestionService } from '../services/ingestion.service.js';
import { modelService } from '../services/model.service.js';
import {
  jobService,
  type IngestionJobPayload,
  type FolderImportJobPayload,
  type ScanJobPayload,
  type CommitJobPayload,
} from '../services/job.service.js';
import { parseRedisUrl } from '../utils/redis.js';
import { createLogger } from '../utils/logger.js';

const INGESTION_QUEUE = 'ingestion';
const logger = createLogger('IngestionWorker');

let ingestionWorker: Worker | null = null;
let importWorker: Worker | null = null;
let importScanWorker: Worker | null = null;
let importCommitWorker: Worker | null = null;

export function startIngestionWorker(): void {
  const connection = parseRedisUrl(config.redisUrl);

  ingestionWorker = new Worker(
    INGESTION_QUEUE,
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

  ingestionWorker.on('failed', async (job, err) => {
    logger.error(
      { jobId: job?.id, modelId: job?.data?.modelId, error: err.message },
      'Ingestion job failed',
    );
    // Safety net: if all retries exhausted, ensure model is marked as error
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      try {
        await modelService.updateModelStatus(job.data.modelId, 'error');
      } catch (updateErr) {
        logger.error(
          { modelId: job.data.modelId, error: String(updateErr) },
          'Failed to update model status after job failure',
        );
      }
    }
  });

  importWorker = new Worker(
    jobService.folderImportQueueName,
    async (job: Job<FolderImportJobPayload>) => {
      logger.info({ jobId: job.id, sourcePath: job.data.sourcePath }, 'Folder import job started');

      await ingestionService.processFolderImportJob(job);

      logger.info({ jobId: job.id }, 'Folder import job completed');
    },
    {
      connection,
      concurrency: 1,
    },
  );

  importWorker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, sourcePath: job?.data?.sourcePath, error: err.message },
      'Folder import job failed',
    );
  });

  // Staged-upload scan worker: extract + detect, mark ready for review.
  importScanWorker = new Worker(
    jobService.importScanQueueName,
    async (job: Job<ScanJobPayload>) => {
      const { sessionId, tempFilePath, originalFilename, libraryId, multipart } = job.data;
      logger.info({ jobId: job.id, sessionId }, 'Scan job started');
      await ingestionService.processScanJob(
        sessionId,
        tempFilePath,
        originalFilename,
        libraryId,
        multipart,
      );
      logger.info({ jobId: job.id, sessionId }, 'Scan job completed');
    },
    {
      connection,
      concurrency: 2,
    },
  );

  importScanWorker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, sessionId: job?.data?.sessionId, error: err.message },
      'Scan job failed',
    );
  });

  // Staged-upload commit worker: persist files + apply batch metadata.
  importCommitWorker = new Worker(
    jobService.importCommitQueueName,
    async (job: Job<CommitJobPayload>) => {
      logger.info(
        { jobId: job.id, sessionId: job.data.sessionId, modelId: job.data.modelId },
        'Commit job started',
      );
      await ingestionService.processCommitJob(job);
      logger.info({ jobId: job.id, sessionId: job.data.sessionId }, 'Commit job completed');
    },
    {
      connection,
      concurrency: 2,
    },
  );

  importCommitWorker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, sessionId: job?.data?.sessionId, error: err.message },
      'Commit job failed',
    );
  });
}

export function stopIngestionWorker(): Promise<void> {
  return Promise.all([
    ingestionWorker ? ingestionWorker.close() : Promise.resolve(),
    importWorker ? importWorker.close() : Promise.resolve(),
    importScanWorker ? importScanWorker.close() : Promise.resolve(),
    importCommitWorker ? importCommitWorker.close() : Promise.resolve(),
  ]).then(() => {});
}
