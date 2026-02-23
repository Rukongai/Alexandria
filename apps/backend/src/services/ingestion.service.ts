import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { Job } from 'bullmq';
import { jobService, type IngestionJobPayload } from './job.service.js';
import { fileProcessingService } from './file-processing.service.js';
import { thumbnailService } from './thumbnail.service.js';
import { modelService } from './model.service.js';
import { storageService } from './storage.service.js';
import { generateSlug } from '../utils/slug.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('IngestionService');

export class IngestionService {
  async handleUpload(
    file: { tempFilePath: string; originalFilename: string },
    userId: string,
  ): Promise<{ modelId: string; jobId: string }> {
    const name = file.originalFilename.replace(/\.zip$/i, '');
    const slug = generateSlug(name);

    const { id: modelId } = await modelService.createModel({
      name,
      slug,
      userId,
      sourceType: 'zip_upload',
      status: 'processing',
      originalFilename: file.originalFilename,
    });

    const jobId = await jobService.enqueueIngestionJob({
      modelId,
      tempFilePath: file.tempFilePath,
      originalFilename: file.originalFilename,
      userId,
    });

    logger.info({ modelId, jobId }, 'Upload accepted, ingestion job enqueued');
    return { modelId, jobId };
  }

  async processIngestionJob(
    jobId: string,
    modelId: string,
    tempFilePath: string,
    userId: string,
    job: Job<IngestionJobPayload>,
  ): Promise<void> {
    const extractDir = `${tempFilePath}_extracted`;

    try {
      await job.updateProgress(0);
      logger.info({ modelId, jobId }, 'Processing started');

      // Step 1: Extract zip and classify files
      const manifest = await fileProcessingService.processZip(tempFilePath, extractDir);
      await job.updateProgress(20);
      logger.info({ modelId, jobId, fileCount: manifest.entries.length }, 'Zip extracted');

      // Step 2: Copy files to managed storage (delegated to FileProcessingService)
      await fileProcessingService.copyManifestToStorage(
        extractDir,
        modelId,
        manifest,
        storageService,
      );
      await job.updateProgress(50);

      // Build model file input records with storage paths
      const modelFileInputs = manifest.entries.map((entry) => ({
        filename: entry.filename,
        relativePath: entry.relativePath,
        fileType: entry.fileType,
        mimeType: entry.mimeType,
        sizeBytes: entry.sizeBytes,
        storagePath: `models/${modelId}/${entry.relativePath}`,
        hash: entry.hash,
      }));

      // Step 3: Insert model file records
      const createdFiles = await modelService.createModelFiles(modelId, modelFileInputs);

      // Step 4: Generate thumbnails for image files
      await job.updateProgress(75);

      const allThumbnailRecords: Array<{
        sourceFileId: string;
        storagePath: string;
        width: number;
        height: number;
        format: string;
      }> = [];

      for (let i = 0; i < modelFileInputs.length; i++) {
        const fileInput = modelFileInputs[i];
        const createdFile = createdFiles[i];

        if (fileInput.fileType !== 'image') continue;

        const sourcePath = path.join(extractDir, fileInput.relativePath);

        try {
          const thumbnailRecords = await thumbnailService.generateThumbnails(
            sourcePath,
            modelId,
            createdFile.id,
          );
          allThumbnailRecords.push(...thumbnailRecords);
        } catch (err) {
          logger.warn(
            { modelId, jobId, fileId: createdFile.id, error: String(err) },
            'Thumbnail generation failed (non-fatal)',
          );
        }
      }

      // Step 5: Insert thumbnail records
      await modelService.createThumbnails(allThumbnailRecords);

      // Step 6: Update model to ready
      await modelService.updateModelStatus(modelId, 'ready', {
        totalSizeBytes: manifest.totalSizeBytes,
        fileCount: manifest.entries.length,
      });

      await job.updateProgress(100);
      logger.info({ modelId, jobId }, 'Processing completed — model is ready');
    } catch (err) {
      logger.error({ modelId, jobId, error: String(err) }, 'Processing failed');
      await modelService.updateModelStatus(modelId, 'error');
      throw err;
    } finally {
      // Clean up temp files
      await fsPromises.rm(tempFilePath, { force: true });
      await fsPromises.rm(extractDir, { recursive: true, force: true });
    }
  }
}

export const ingestionService = new IngestionService();
