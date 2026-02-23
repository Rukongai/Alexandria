import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { Job } from 'bullmq';
import type { ImportConfig } from '@alexandria/shared';
import { jobService, type IngestionJobPayload, type FolderImportJobPayload } from './job.service.js';
import { fileProcessingService } from './file-processing.service.js';
import { thumbnailService } from './thumbnail.service.js';
import { modelService } from './model.service.js';
import { metadataService } from './metadata.service.js';
import { collectionService } from './collection.service.js';
import { storageService } from './storage.service.js';
import { createImportStrategy } from './import-strategy.service.js';
import { parsePattern } from '../utils/pattern-parser.js';
import { generateSlug } from '../utils/slug.js';
import { createLogger } from '../utils/logger.js';
import { AppError, validationError } from '../utils/errors.js';

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

    let jobId: string;
    try {
      jobId = await jobService.enqueueIngestionJob({
        modelId,
        tempFilePath: file.tempFilePath,
        originalFilename: file.originalFilename,
        userId,
      });
    } catch (err) {
      logger.error({ modelId, error: String(err) }, 'Failed to enqueue ingestion job');
      await modelService.updateModelStatus(modelId, 'error');
      throw err;
    }

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
      await this.generateAndStoreThumbnails(modelId, modelFileInputs, createdFiles, extractDir);

      // Step 6: Update model to ready
      await modelService.updateModelStatus(modelId, 'ready', {
        totalSizeBytes: manifest.totalSizeBytes,
        fileCount: manifest.entries.length,
      });

      await job.updateProgress(100);
      logger.info({ modelId, jobId }, 'Processing completed — model is ready');
    } catch (err) {
      logger.error({ modelId, jobId, error: String(err) }, 'Processing failed');
      const maxAttempts = job.opts.attempts ?? 1;
      if (job.attemptsMade >= maxAttempts - 1) {
        await modelService.updateModelStatus(modelId, 'error');
      }
      throw err;
    } finally {
      // Only clean up temp files on success or final attempt to preserve files for BullMQ retries
      const maxAttempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade >= maxAttempts - 1;
      if (!job.failedReason || isFinalAttempt) {
        await fsPromises.rm(tempFilePath, { force: true });
        await fsPromises.rm(extractDir, { recursive: true, force: true });
      }
    }
  }
  async handleFolderImport(
    importConfig: ImportConfig,
    userId: string,
  ): Promise<{ jobId: string }> {
    // Validate pattern
    parsePattern(importConfig.pattern);

    // Validate source path is accessible
    try {
      const stat = await fsPromises.stat(importConfig.sourcePath);
      if (!stat.isDirectory()) {
        throw validationError('Source path is not a directory', 'sourcePath');
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw validationError('Source path does not exist', 'sourcePath');
      }
      if (code === 'EACCES') {
        throw validationError('Source path is not accessible', 'sourcePath');
      }
      throw validationError(
        `Cannot access source path: ${err instanceof Error ? err.message : String(err)}`,
        'sourcePath',
      );
    }

    const jobId = await jobService.enqueueFolderImportJob({
      sourcePath: importConfig.sourcePath,
      pattern: importConfig.pattern,
      strategy: importConfig.strategy,
      userId,
    });

    logger.info({ jobId, sourcePath: importConfig.sourcePath, pattern: importConfig.pattern }, 'Folder import job enqueued');
    return { jobId };
  }

  async processFolderImportJob(
    job: Job<FolderImportJobPayload>,
  ): Promise<void> {
    const { sourcePath, pattern, strategy, userId } = job.data;
    const parsedPattern = parsePattern(pattern);
    const importStrategy = createImportStrategy(strategy);

    try {
      // Step 1: Discover models by walking directory tree
      await job.updateProgress(5);
      const discovered = await fileProcessingService.walkDirectoryForImport(sourcePath, parsedPattern);

      if (discovered.length === 0) {
        logger.warn({ jobId: job.id, sourcePath, pattern }, 'No models discovered');
        await job.updateProgress(100);
        return;
      }

      logger.info({ jobId: job.id, modelsFound: discovered.length }, 'Models discovered');

      // Step 2: Process each discovered model
      let processed = 0;
      let failed = 0;

      for (const model of discovered) {
        try {
          await this.processDiscoveredModel(model, importStrategy, userId, job);
          processed++;
        } catch (err) {
          failed++;
          logger.error(
            { jobId: job.id, modelName: model.name, error: String(err) },
            'Failed to process discovered model',
          );
        }

        // Update progress proportionally
        const progressPct = Math.round(10 + ((processed + failed) / discovered.length) * 90);
        await job.updateProgress(progressPct);
      }

      logger.info(
        { jobId: job.id, processed, failed, total: discovered.length },
        'Folder import completed',
      );
    } catch (err) {
      logger.error({ jobId: job.id, error: String(err) }, 'Folder import job failed');
      throw err;
    }
  }

  private async generateAndStoreThumbnails(
    modelId: string,
    fileInputs: Array<{ fileType: string; relativePath: string }>,
    createdFiles: Array<{ id: string; fileType: string }>,
    sourceDir: string,
  ): Promise<void> {
    const allThumbnailRecords: Array<{
      sourceFileId: string;
      storagePath: string;
      width: number;
      height: number;
      format: string;
    }> = [];

    for (let i = 0; i < fileInputs.length; i++) {
      const fileInput = fileInputs[i];
      const createdFile = createdFiles[i];

      if (fileInput.fileType !== 'image') continue;

      const sourcePath = path.join(sourceDir, fileInput.relativePath);
      try {
        const thumbnailRecords = await thumbnailService.generateThumbnails(
          sourcePath,
          modelId,
          createdFile.id,
        );
        allThumbnailRecords.push(...thumbnailRecords);
      } catch (err) {
        logger.warn(
          { modelId, fileId: createdFile.id, error: String(err) },
          'Thumbnail generation failed (non-fatal)',
        );
      }
    }

    await modelService.createThumbnails(allThumbnailRecords);
  }

  private async processDiscoveredModel(
    discovered: import('./file-processing.service.js').DiscoveredModel,
    importStrategy: import('./import-strategy.service.js').IImportStrategy,
    userId: string,
    job: Job,
  ): Promise<void> {
    const slug = generateSlug(discovered.name);

    // Create model record in processing state
    const { id: modelId } = await modelService.createModel({
      name: discovered.name,
      slug,
      userId,
      sourceType: 'folder_import',
      status: 'processing',
    });

    try {
      // Scan files in the model's source directory
      const entries = await fileProcessingService.scanDirectory(
        discovered.sourcePath,
        discovered.sourcePath,
      );
      const totalSizeBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);

      // Execute import strategy to copy/link files into managed storage
      for (const entry of entries) {
        const srcFile = path.join(discovered.sourcePath, entry.relativePath);
        const storagePath = `models/${modelId}/${entry.relativePath}`;
        const targetPath = storageService.resolveStoragePath(storagePath);
        await importStrategy.execute(srcFile, targetPath);
      }

      // Create model file records
      const modelFileInputs = entries.map((entry) => ({
        filename: entry.filename,
        relativePath: entry.relativePath,
        fileType: entry.fileType,
        mimeType: entry.mimeType,
        sizeBytes: entry.sizeBytes,
        storagePath: `models/${modelId}/${entry.relativePath}`,
        hash: entry.hash,
      }));

      const createdFiles = await modelService.createModelFiles(modelId, modelFileInputs);

      // Generate thumbnails for image files
      await this.generateAndStoreThumbnails(modelId, modelFileInputs, createdFiles, discovered.sourcePath);

      // Assign metadata from pattern
      if (Object.keys(discovered.metadata).length > 0) {
        await metadataService.setModelMetadata(modelId, discovered.metadata);
      }

      // Assign collection from pattern
      if (discovered.collectionName) {
        const collection = await collectionService.findOrCreateByName(
          discovered.collectionName,
          userId,
        );
        await collectionService.addModelToCollection(collection.id, modelId);
      }

      // Update model to ready
      await modelService.updateModelStatus(modelId, 'ready', {
        totalSizeBytes,
        fileCount: entries.length,
      });

      logger.info({ modelId, name: discovered.name }, 'Model imported successfully');
    } catch (err) {
      await modelService.updateModelStatus(modelId, 'error');
      throw err;
    }
  }
}

export const ingestionService = new IngestionService();
