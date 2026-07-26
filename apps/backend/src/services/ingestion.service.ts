import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Job } from 'bullmq';
import type {
  ImportConfig,
  BatchUploadMetadata,
  DetectedImportMetadata,
  DetectedFolderNode,
  ExtractArchiveResponse,
  ImportCommitProgress,
  ImportSession,
  MultipartArchiveMode,
  SetModelMetadataRequest,
} from '@alexandria/shared';
import {
  jobService,
  type IngestionJobPayload,
  type FolderImportJobPayload,
  type CommitJobPayload,
} from './job.service.js';
import { forEachWithConcurrency } from '../utils/concurrency.js';
import { fileProcessingService, type FileManifest } from './file-processing.service.js';
import { importSessionService } from './import-session.service.js';
import { thumbnailService } from './thumbnail.service.js';
import { modelService } from './model.service.js';
import { metadataService } from './metadata.service.js';
import { collectionService } from './collection.service.js';
import {
  isLocalStorageService,
  storageService,
  storeVerified,
  uploadConcurrencyFor,
} from './storage.service.js';
import { createImportStrategy } from './import-strategy.service.js';
import { parsePattern } from '../utils/pattern-parser.js';
import { detectArchiveExtension, stripArchiveExtension } from '../utils/archive.js';
import { readMetadataFile } from '../utils/metadata-file.js';
import { generateSlug } from '../utils/slug.js';
import { createLogger } from '../utils/logger.js';
import { AppError, storageError, validationError } from '../utils/errors.js';
import { db } from '../db/index.js';

const logger = createLogger('IngestionService');

interface VerifiedImportSource {
  filePath: string;
  hash: string;
  sizeBytes: number;
}

/** File extensions treated as 3D model files when counting sub-models. */
const MODEL_FILE_EXTENSIONS = new Set(['stl', 'obj', '3mf', 'step', 'stp', 'ply']);
/** Path tokens too generic to ever be a useful auto-tag. */
const TAG_STOPWORDS = new Set([
  'stl', 'obj', 'zip', 'rar', 'files', 'file', 'model', 'models', 'the', 'and',
  'supported', 'unsupported', 'presupported', 'lys', 'renders', 'render', 'images',
]);

export class IngestionService {
  private archiveDestinationPath(
    archiveRelativePath: string,
    occupiedPaths: Iterable<string>,
  ): string {
    const parentPath = path.posix.dirname(archiveRelativePath);
    const archiveName = path.posix.basename(archiveRelativePath);
    const folderName = stripArchiveExtension(archiveName) || 'extracted';
    const parent = parentPath === '.' ? '' : parentPath;
    const occupied = [...occupiedPaths];

    for (let index = 1; ; index += 1) {
      const suffix = index === 1 ? '' : `-${index}`;
      const candidate = path.posix.join(parent, `${folderName}${suffix}`);
      const isOccupied = occupied.some(
        (entryPath) => entryPath === candidate || entryPath.startsWith(`${candidate}/`),
      );
      if (!isOccupied) return candidate;
    }
  }

  async handleUpload(
    file: { tempFilePath: string; originalFilename: string },
    userId: string,
    libraryId: string,
  ): Promise<{ modelId: string; jobId: string }> {
    const name = stripArchiveExtension(file.originalFilename);
    const slug = generateSlug(name);

    const { id: modelId } = await modelService.createModel({
      name,
      slug,
      userId,
      libraryId,
      sourceType: 'archive_upload',
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
        libraryId,
      });
    } catch (err) {
      logger.error({ modelId, error: String(err) }, 'Failed to enqueue ingestion job');
      await modelService.updateModelStatus(modelId, 'error');
      throw err;
    }

    logger.info({ service: 'IngestionService', modelId, jobId, libraryId }, 'Upload accepted, ingestion job enqueued');
    return { modelId, jobId };
  }

  // -------------------------------------------------------------------------
  // Staged upload: scan → review → commit
  // -------------------------------------------------------------------------

  /**
   * Accept an uploaded archive and enqueue a scan. Creates an import session
   * (not a model) — the archive is extracted + inspected without being committed.
   */
  async handleScan(
    file: { tempFilePath: string; originalFilename: string },
    userId: string,
    libraryId: string,
  ): Promise<{ sessionId: string }> {
    const { id: sessionId } = await importSessionService.create({
      userId,
      libraryId,
      originalFilename: file.originalFilename,
    });

    try {
      await jobService.enqueueScanJob({
        sessionId,
        tempFilePath: file.tempFilePath,
        originalFilename: file.originalFilename,
        userId,
        libraryId,
      });
    } catch (err) {
      logger.error({ sessionId, error: String(err) }, 'Failed to enqueue scan job');
      await importSessionService.update(sessionId, { status: 'error', error: 'Failed to start scan' });
      throw err;
    }

    logger.info({ service: 'IngestionService', sessionId, libraryId }, 'Upload accepted, scan job enqueued');
    return { sessionId };
  }

  /** Accept an explicit archive group and enqueue one scan/import session. */
  async handleMultipartScan(
    files: Array<{ tempFilePath: string; originalFilename: string }>,
    mode: MultipartArchiveMode,
    userId: string,
    libraryId: string,
  ): Promise<{ sessionId: string }> {
    let enqueued = false;
    try {
      const originalFilename = fileProcessingService.validateMultipartArchives(files, mode);
      const { id: sessionId } = await importSessionService.create({
        userId,
        libraryId,
        originalFilename,
      });

      try {
        await jobService.enqueueScanJob({
          sessionId,
          tempFilePath: files[0].tempFilePath,
          originalFilename,
          userId,
          libraryId,
          multipart: { files, mode },
        });
        enqueued = true;
      } catch (error) {
        logger.error({ sessionId, error: String(error) }, 'Failed to enqueue multipart scan job');
        await importSessionService.update(sessionId, {
          status: 'error',
          error: 'Failed to start scan',
        });
        throw error;
      }

      logger.info(
        { service: 'IngestionService', sessionId, libraryId, mode, archiveCount: files.length },
        'Multipart upload accepted, scan job enqueued',
      );
      return { sessionId };
    } finally {
      if (!enqueued) {
        await Promise.all(
          files.map((file) => fsPromises.rm(file.tempFilePath, { force: true }).catch(() => {})),
        );
      }
    }
  }

  /** Worker entry: extract the archive, detect metadata, mark ready for review. */
  async processScanJob(
    sessionId: string,
    tempFilePath: string,
    originalFilename: string,
    libraryId: string,
    multipart?: {
      files: Array<{ tempFilePath: string; originalFilename: string }>;
      mode: MultipartArchiveMode;
    },
  ): Promise<void> {
    const extractDir = `${tempFilePath}_extracted`;
    try {
      const manifest = multipart
        ? await fileProcessingService.processMultipartArchives(
          multipart.files,
          extractDir,
          multipart.mode,
        )
        : await fileProcessingService.processArchive(tempFilePath, extractDir);
      const detected = await this.detectImportMetadata(
        manifest,
        originalFilename,
        libraryId,
        extractDir,
      );
      if (multipart) {
        detected.modelCount = 1;
      }
      await importSessionService.update(sessionId, {
        status: 'ready_for_review',
        manifest,
        detected,
        stagingPath: extractDir,
      });
      logger.info({ sessionId, fileCount: manifest.entries.length }, 'Scan complete — ready for review');
    } catch (err) {
      const clientError = err instanceof AppError
        ? err.message
        : 'Could not process this archive';
      if (err instanceof AppError) {
        logger.warn({ sessionId, errorCode: err.code, error: err.message }, 'Scan rejected');
      } else {
        logger.error({ sessionId, err }, 'Scan failed');
      }
      await importSessionService.update(sessionId, {
        status: 'error',
        error: clientError,
      });
      await fsPromises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    } finally {
      // Uploaded archives are no longer needed once extracted (or on failure).
      const inputPaths = multipart
        ? new Set(multipart.files.map((file) => file.tempFilePath))
        : new Set([tempFilePath]);
      await Promise.all(
        [...inputPaths].map((inputPath) => fsPromises.rm(inputPath, { force: true }).catch(() => {})),
      );
    }
  }

  /** Extract one nested archive into a sibling folder inside a staged session. */
  async extractSessionArchive(
    sessionId: string,
    relativePath: string,
    userId: string,
    libraryId: string,
  ): Promise<ImportSession> {
    const session = await importSessionService.getOwnedRow(sessionId, userId);
    if (session.libraryId !== libraryId) {
      throw validationError('Import session belongs to a different library');
    }
    if (session.status !== 'ready_for_review') {
      throw validationError(`Import session is not ready for extraction (status: ${session.status})`);
    }

    const manifest = session.manifest as FileManifest | null;
    const archiveEntry = manifest?.entries.find((entry) => entry.relativePath === relativePath);
    if (!manifest || !session.stagingPath || !archiveEntry) {
      throw validationError('Archive file was not found in this import session', 'relativePath');
    }
    if (!detectArchiveExtension(archiveEntry.filename)) {
      throw validationError('Selected file is not a supported archive', 'relativePath');
    }

    const stagingRoot = path.resolve(session.stagingPath);
    const archivePath = path.resolve(stagingRoot, archiveEntry.relativePath);
    if (!archivePath.startsWith(stagingRoot + path.sep) || archivePath === stagingRoot) {
      throw validationError('Archive path is outside the staged upload', 'relativePath');
    }

    const occupiedPaths = new Set(manifest.entries.map((entry) => entry.relativePath));
    let destinationRelativePath: string;
    let destinationPath: string;
    while (true) {
      destinationRelativePath = this.archiveDestinationPath(archiveEntry.relativePath, occupiedPaths);
      destinationPath = path.resolve(stagingRoot, destinationRelativePath);
      const exists = await fsPromises.access(destinationPath).then(() => true).catch(() => false);
      if (!exists) break;
      occupiedPaths.add(destinationRelativePath);
    }

    try {
      await fileProcessingService.processArchive(archivePath, destinationPath);
      const entries = await fileProcessingService.scanDirectory(stagingRoot, stagingRoot);
      const nextManifest: FileManifest = {
        entries,
        totalSizeBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      };
      const detected = await this.detectImportMetadata(
        nextManifest,
        session.originalFilename,
        libraryId,
        stagingRoot,
      );
      await importSessionService.update(sessionId, { manifest: nextManifest, detected });
      const updated = await importSessionService.getOwnedRow(sessionId, userId);
      return importSessionService.toDto(updated);
    } catch (error) {
      await fsPromises.rm(destinationPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /** Add loose files to a staged session and refresh its detected metadata. */
  async appendFilesToSession(
    files: Array<{ tempFilePath: string; originalFilename: string }>,
    sessionId: string,
    userId: string,
    libraryId: string,
  ): Promise<ImportSession> {
    const session = await importSessionService.getOwnedRow(sessionId, userId);
    if (session.libraryId !== libraryId) {
      throw validationError('Import session belongs to a different library');
    }
    if (session.status !== 'ready_for_review') {
      throw validationError(`Import session is not ready for files (status: ${session.status})`);
    }
    if (!session.stagingPath || !session.manifest) {
      throw validationError('Import session is missing its staged files');
    }
    if (files.length === 0) {
      throw validationError('No file provided');
    }

    const stagingRoot = path.resolve(session.stagingPath);
    const manifest = session.manifest as FileManifest;
    const occupiedPaths = new Set(manifest.entries.map((entry) => entry.relativePath));
    const addedPaths: string[] = [];

    try {
      for (const file of files) {
        const requestedName = path.posix.basename(file.originalFilename.replaceAll('\\', '/'));
        if (!requestedName || requestedName.startsWith('.')) {
          throw validationError(`Unsupported filename: ${file.originalFilename}`);
        }

        const extension = path.posix.extname(requestedName);
        const stem = requestedName.slice(0, requestedName.length - extension.length) || 'file';
        let relativePath = requestedName;
        for (let suffix = 2; occupiedPaths.has(relativePath); suffix += 1) {
          relativePath = `${stem} (${suffix})${extension}`;
        }

        const destinationPath = path.resolve(stagingRoot, relativePath);
        if (!destinationPath.startsWith(stagingRoot + path.sep)) {
          throw validationError(`Unsupported filename: ${file.originalFilename}`);
        }
        await fsPromises.copyFile(file.tempFilePath, destinationPath);
        occupiedPaths.add(relativePath);
        addedPaths.push(destinationPath);
      }

      const entries = await fileProcessingService.scanDirectory(stagingRoot, stagingRoot);
      const nextManifest: FileManifest = {
        entries,
        totalSizeBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      };
      const detected = await this.detectImportMetadata(
        nextManifest,
        session.originalFilename,
        libraryId,
        stagingRoot,
      );
      await importSessionService.update(sessionId, { manifest: nextManifest, detected });
      const updated = await importSessionService.getOwnedRow(sessionId, userId);
      return importSessionService.toDto(updated);
    } catch (error) {
      await Promise.all(
        addedPaths.map((filePath) => fsPromises.rm(filePath, { force: true }).catch(() => {})),
      );
      throw error;
    } finally {
      await Promise.all(
        files.map((file) => fsPromises.rm(file.tempFilePath, { force: true }).catch(() => {})),
      );
    }
  }

  /** Extract one stored archive into a sibling folder in an existing model. */
  async extractModelArchive(
    modelId: string,
    fileId: string,
    userId: string,
    libraryId: string,
  ): Promise<ExtractArchiveResponse> {
    await modelService.requireOwnedModel(modelId, userId, libraryId);
    const [files, folders] = await Promise.all([
      modelService.getModelFiles(modelId),
      modelService.getModelFolders(modelId),
    ]);
    const archiveFile = files.find((file) => file.id === fileId);
    if (!archiveFile) {
      throw validationError('Archive file was not found in this model', 'fileId');
    }
    const archiveExtension = detectArchiveExtension(archiveFile.filename);
    if (!archiveExtension) {
      throw validationError('Selected file is not a supported archive', 'fileId');
    }

    const destinationPath = this.archiveDestinationPath(
      archiveFile.relativePath,
      [
        ...files.map((file) => file.relativePath),
        ...folders.map((folder) => folder.path),
      ],
    );
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'alexandria-extract-'));
    const localArchivePath = path.join(tempRoot, `source${archiveExtension}`);
    const extractDir = path.join(tempRoot, 'contents');
    const storedPaths: string[] = [];
    let filesCreated = false;

    try {
      await pipeline(
        await storageService.retrieveStream(archiveFile.storagePath),
        fs.createWriteStream(localArchivePath),
      );
      const manifest = await fileProcessingService.processArchive(localArchivePath, extractDir);
      const fileInputs = manifest.entries.map((entry) => ({
        ...entry,
        sourceRelativePath: entry.relativePath,
        relativePath: path.posix.join(destinationPath, entry.relativePath),
        storagePath: `models/${modelId}/${path.posix.join(destinationPath, entry.relativePath)}`,
      }));

      await forEachWithConcurrency(
        fileInputs,
        uploadConcurrencyFor(storageService),
        async (fileInput) => {
          const sourcePath = path.join(extractDir, fileInput.sourceRelativePath);
          await storageService.store(fileInput.storagePath, fs.createReadStream(sourcePath));
          // Recorded as each upload lands so the failure path can clean up
          // whatever finished before the batch aborted.
          storedPaths.push(fileInput.storagePath);
        },
      );

      const createdFiles = await modelService.createModelFiles(modelId, fileInputs);
      filesCreated = true;
      await this.generateAndStoreThumbnails(modelId, fileInputs, createdFiles, extractDir);
      await modelService.recalculateModelStats(modelId);

      return { addedFileCount: fileInputs.length, destinationPath };
    } catch (error) {
      if (!filesCreated) {
        await Promise.all(
          storedPaths.map((storedPath) => storageService.delete(storedPath).catch(() => {})),
        );
      }
      throw error;
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Promote a reviewed session into a real model. Creates the model row up front
   * (so the client can poll status), then enqueues the commit job.
   */
  async handleCommit(
    sessionId: string,
    batchMetadata: BatchUploadMetadata | undefined,
    userId: string,
    libraryId: string,
  ): Promise<{ modelId: string; jobId: string }> {
    const { modelId, effectiveBatchMetadata } = await db.transaction(async (tx) => {
      // This is the same deterministic import-session row lock used by AI
      // proposal apply. Only one transaction can observe ready_for_review and
      // claim the session, so concurrent commits cannot create two models and
      // an AI draft apply cannot race between the draft read and state change.
      const [session] = await importSessionService.lockOwnedSessions(
        [sessionId],
        userId,
        libraryId,
        tx,
      );
      if (session.status !== 'ready_for_review') {
        throw validationError(`Import session is not ready to commit (status: ${session.status})`);
      }

      // An explicit review form submission is authoritative. When omitted,
      // resolve the persisted draft while its session row remains locked.
      const resolvedBatchMetadata = batchMetadata
        ?? (session.draftMetadata as BatchUploadMetadata | null)
        ?? undefined;

      // Validate collection scope in the same transaction as the claim.
      if (resolvedBatchMetadata?.collectionId) {
        await collectionService.requireOwnedCollection(
          resolvedBatchMetadata.collectionId,
          userId,
          libraryId,
          tx,
        );
      }
      const metadataValues = this.buildBatchMetadataValues(resolvedBatchMetadata);
      for (const [fieldSlug, value] of Object.entries(metadataValues)) {
        const field = await metadataService.getFieldBySlug(fieldSlug, tx);
        metadataService.validateFieldValue(field, value);
      }

      const reviewedName = resolvedBatchMetadata?.modelName?.trim();
      const name = reviewedName || stripArchiveExtension(session.originalFilename);
      const slug = generateSlug(name);
      const { id } = await modelService.createModel({
        name,
        slug,
        description: resolvedBatchMetadata?.description ?? null,
        userId,
        libraryId,
        sourceType: 'archive_upload',
        status: 'processing',
        originalFilename: session.originalFilename,
      }, tx);
      await importSessionService.update(
        sessionId,
        { status: 'committing', modelId: id },
        tx,
      );
      return { modelId: id, effectiveBatchMetadata: resolvedBatchMetadata };
    });

    let jobId: string;
    try {
      jobId = await jobService.enqueueCommitJob({
        sessionId,
        modelId,
        userId,
        libraryId,
        batchMetadata: effectiveBatchMetadata,
      });
    } catch (err) {
      logger.error({ sessionId, modelId, error: String(err) }, 'Failed to enqueue commit job');
      await modelService.updateModelStatus(modelId, 'error');
      await importSessionService.update(sessionId, { status: 'error', error: 'Failed to start commit' });
      throw err;
    }

    logger.info({ service: 'IngestionService', sessionId, modelId, jobId }, 'Commit accepted, job enqueued');
    return { modelId, jobId };
  }

  /** Worker entry: copy staged files to storage, finalize the model, apply metadata. */
  async processCommitJob(job: Job<CommitJobPayload>): Promise<void> {
    const { sessionId, modelId, userId, libraryId, batchMetadata } = job.data;

    const session = await importSessionService.getRow(sessionId);
    if (!session) {
      logger.error({ sessionId }, 'Commit job: session not found');
      return;
    }
    const manifest = session.manifest as FileManifest | null;
    const stagingPath = session.stagingPath;
    if (!manifest || !stagingPath) {
      await modelService.updateModelStatus(modelId, 'error');
      await importSessionService.update(sessionId, { status: 'error', error: 'Missing scanned data' });
      return;
    }

    try {
      const progressBase = {
        completedFiles: 0,
        totalFiles: manifest.entries.length,
        completedBytes: 0,
        totalBytes: manifest.totalSizeBytes,
        currentFilename: null,
      };
      await this.updateCommitProgress(job, {
        ...progressBase,
        phase: 'queued',
        percent: 0,
      });
      await fileProcessingService.copyManifestToStorage(
        stagingPath,
        modelId,
        manifest,
        storageService,
        async (storageProgress) => {
          const storageRatio = storageProgress.totalBytes > 0
            ? storageProgress.completedBytes / storageProgress.totalBytes
            : storageProgress.totalFiles > 0
              ? storageProgress.completedFiles / storageProgress.totalFiles
              : 1;
          await this.updateCommitProgress(job, {
            ...storageProgress,
            phase: 'storing_files',
            percent: Math.min(80, Math.max(0, Math.round(storageRatio * 80))),
          });
        },
      );
      const transferred = {
        completedFiles: manifest.entries.length,
        totalFiles: manifest.entries.length,
        completedBytes: manifest.totalSizeBytes,
        totalBytes: manifest.totalSizeBytes,
        currentFilename: null,
      };
      await this.updateCommitProgress(job, {
        ...transferred,
        phase: 'saving_records',
        percent: 85,
      });

      const modelFileInputs = manifest.entries.map((entry) => ({
        filename: entry.filename,
        relativePath: entry.relativePath,
        fileType: entry.fileType,
        mimeType: entry.mimeType,
        sizeBytes: entry.sizeBytes,
        storagePath: `models/${modelId}/${entry.relativePath}`,
        hash: entry.hash,
      }));

      const createdFiles = await modelService.createModelFiles(modelId, modelFileInputs);
      await this.updateCommitProgress(job, {
        ...transferred,
        phase: 'generating_thumbnails',
        percent: 90,
      });
      await this.generateAndStoreThumbnails(modelId, modelFileInputs, createdFiles, stagingPath);

      await modelService.updateModelStatus(modelId, 'ready', {
        totalSizeBytes: manifest.totalSizeBytes,
        fileCount: manifest.entries.length,
      });

      // Apply user-reviewed metadata after the model is ready — non-fatal.
      await this.updateCommitProgress(job, {
        ...transferred,
        phase: 'applying_metadata',
        percent: 95,
      });
      await this.applyBatchMetadata(modelId, userId, libraryId, batchMetadata);

      await this.updateCommitProgress(job, {
        ...transferred,
        phase: 'complete',
        percent: 100,
      });
      await importSessionService.update(sessionId, { status: 'committed' });
      logger.info({ sessionId, modelId }, 'Commit complete — model is ready');
    } catch (err) {
      logger.error({ sessionId, modelId, error: String(err) }, 'Commit failed');
      const maxAttempts = job.opts.attempts ?? 1;
      if (job.attemptsMade >= maxAttempts - 1) {
        await modelService.updateModelStatus(modelId, 'error');
        await importSessionService.update(sessionId, {
          status: 'error',
          error: err instanceof Error ? err.message : 'Commit failed',
        });
      }
      throw err;
    } finally {
      const maxAttempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade >= maxAttempts - 1;
      if (!job.failedReason || isFinalAttempt) {
        await fsPromises.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  private async updateCommitProgress(
    job: Job<CommitJobPayload>,
    progress: ImportCommitProgress,
  ): Promise<void> {
    try {
      await job.updateProgress(progress);
    } catch (error) {
      logger.warn(
        { jobId: job.id, sessionId: job.data.sessionId, error: String(error) },
        'Failed to update commit progress',
      );
    }
  }

  async appendUploadToModel(
    file: { tempFilePath: string; originalFilename: string },
    modelId: string,
    userId: string,
    libraryId: string,
  ): Promise<{ modelId: string; addedFileCount: number }> {
    await modelService.requireOwnedModel(modelId, userId, libraryId);

    const extractDir = `${file.tempFilePath}_extracted`;
    try {
      const archiveExtension = detectArchiveExtension(file.originalFilename);
      const manifest = archiveExtension
        ? await fileProcessingService.processArchive(file.tempFilePath, extractDir)
        : await this.stageSingleFileUpload(file.tempFilePath, file.originalFilename, extractDir);

      if (manifest.entries.length === 0) {
        throw validationError('Upload did not contain any supported files');
      }

      const requestedInputs = manifest.entries.map((entry) => ({
        filename: entry.filename,
        relativePath: entry.relativePath,
        fileType: entry.fileType,
        mimeType: entry.mimeType,
        sizeBytes: entry.sizeBytes,
        storagePath: '',
        hash: entry.hash,
      }));
      const modelFileInputs = await modelService.buildAdditionalFileInputs(modelId, requestedInputs);
      const storedPaths: string[] = [];

      try {
        await forEachWithConcurrency(
          modelFileInputs,
          uploadConcurrencyFor(storageService),
          async (modelFileInput, index) => {
            const sourcePath = path.join(extractDir, manifest.entries[index].relativePath);
            const readStream = fs.createReadStream(sourcePath);
            await storageService.store(modelFileInput.storagePath, readStream);
            storedPaths.push(modelFileInput.storagePath);
          },
        );

        const createdFiles = await modelService.createModelFiles(modelId, modelFileInputs);
        await this.generateAndStoreThumbnails(modelId, manifest.entries, createdFiles, extractDir);
        await modelService.recalculateModelStats(modelId);
      } catch (err) {
        await Promise.all(storedPaths.map((storedPath) => storageService.delete(storedPath).catch(() => {})));
        throw err;
      }

      logger.info(
        { service: 'IngestionService', modelId, fileCount: manifest.entries.length },
        'Additional archive files appended to model',
      );

      return { modelId, addedFileCount: manifest.entries.length };
    } finally {
      await fsPromises.rm(file.tempFilePath, { force: true }).catch(() => {});
      await fsPromises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async stageSingleFileUpload(
    tempFilePath: string,
    originalFilename: string,
    extractDir: string,
  ): Promise<FileManifest> {
    await fsPromises.mkdir(extractDir, { recursive: true });
    const filename = path.basename(originalFilename).replace(/[/\\]/g, '_');
    await fsPromises.copyFile(tempFilePath, path.join(extractDir, filename));
    const entries = await fileProcessingService.scanDirectory(extractDir, extractDir);
    const totalSizeBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    return { entries, totalSizeBytes };
  }

  /** Discard a session that has not been committed, removing staged files. */
  async discardSession(sessionId: string, userId: string): Promise<void> {
    const session = await importSessionService.getOwnedRow(sessionId, userId);
    if (session.stagingPath) {
      await fsPromises.rm(session.stagingPath, { recursive: true, force: true }).catch(() => {});
    }
    await importSessionService.delete(sessionId);
  }

  /** Apply reviewed batch metadata to a committed model. Failures are non-fatal. */
  private async applyBatchMetadata(
    modelId: string,
    userId: string,
    libraryId: string,
    batchMetadata: BatchUploadMetadata | undefined,
  ): Promise<void> {
    if (!batchMetadata) return;
    try {
      const metadata = this.buildBatchMetadataValues(batchMetadata);
      if (Object.keys(metadata).length > 0) {
        await metadataService.setModelMetadata(modelId, metadata);
      }

      if (batchMetadata.collectionId) {
        await collectionService.addModelToCollection(batchMetadata.collectionId, modelId);
      } else if (batchMetadata.newCollectionName) {
        const collection = await collectionService.findOrCreateByName(
          batchMetadata.newCollectionName,
          userId,
          libraryId,
        );
        await collectionService.addModelToCollection(collection.id, modelId);
      }
    } catch (err) {
      logger.warn(
        { modelId, error: String(err) },
        'Failed to apply batch metadata (non-fatal) — model remains ready',
      );
    }
  }

  private buildBatchMetadataValues(
    batchMetadata: BatchUploadMetadata | undefined,
  ): SetModelMetadataRequest {
    if (!batchMetadata) return {};
    const metadata: SetModelMetadataRequest = { ...(batchMetadata.metadata ?? {}) };
    // Dedicated review fields intentionally win over duplicate generic slugs.
    if (batchMetadata.artist !== undefined) metadata.artist = batchMetadata.artist;
    if (batchMetadata.tags !== undefined) metadata.tags = batchMetadata.tags;
    const opts = batchMetadata.options;
    if (opts?.markPreSupported) metadata['pre-supported'] = true;
    if (opts?.markNsfw) metadata.nsfw = true;
    return metadata;
  }

  // -------------------------------------------------------------------------
  // Scan-phase detection helpers (all best-effort)
  // -------------------------------------------------------------------------

  private async detectImportMetadata(
    manifest: FileManifest,
    originalFilename: string,
    libraryId: string,
    rootDir: string,
  ): Promise<DetectedImportMetadata> {
    const entries = manifest.entries;
    const folderStructure = this.buildFolderStructure(entries);

    const topLevelModelDirs = new Set<string>();
    let looseModelFiles = 0;
    for (const e of entries) {
      if (!this.isModelFile(e.filename)) continue;
      const segs = e.relativePath.split('/').filter(Boolean);
      if (segs.length > 1) topLevelModelDirs.add(segs[0]);
      else looseModelFiles++;
    }
    const modelCount = Math.max(1, topLevelModelDirs.size + (looseModelFiles > 0 ? 1 : 0));

    const [artist, tagsGuessed, metadataFile] = await Promise.all([
      this.guessArtist(entries, originalFilename, libraryId),
      this.guessTags(entries, libraryId),
      readMetadataFile(rootDir),
    ]);

    return {
      modelCount,
      fileCount: entries.length,
      totalSizeBytes: manifest.totalSizeBytes,
      artist,
      tagsGuessed,
      folderStructure,
      previewImages: entries
        .filter((entry) => entry.fileType === 'image')
        .map((entry) => ({
          filename: entry.filename,
          relativePath: entry.relativePath,
          mimeType: entry.mimeType,
          sizeBytes: entry.sizeBytes,
        })),
      archives: entries
        .filter((entry) => Boolean(detectArchiveExtension(entry.filename)))
        .map((entry) => ({
          filename: entry.filename,
          relativePath: entry.relativePath,
          sizeBytes: entry.sizeBytes,
        })),
      // Prefill only. Never applied at commit — the client always sends the
      // metadata it intends, so this cannot change an upload's outcome.
      ...(metadataFile ? { metadataFile } : {}),
    };
  }

  private isModelFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return MODEL_FILE_EXTENSIONS.has(ext);
  }

  /** Build a compact folder tree (depth/breadth capped) for the review preview. */
  private buildFolderStructure(
    entries: FileManifest['entries'],
    maxDepth = 3,
    maxChildren = 12,
  ): DetectedFolderNode[] {
    interface MutableNode {
      name: string;
      type: 'folder' | 'file';
      fileType?: DetectedFolderNode['fileType'];
      children: Map<string, MutableNode>;
    }
    const root = new Map<string, MutableNode>();

    for (const entry of entries) {
      const segs = entry.relativePath.split('/').filter(Boolean);
      if (segs.length === 0) continue;
      let level = root;
      for (let i = 0; i < segs.length && i < maxDepth; i++) {
        const isLeaf = i === segs.length - 1;
        const name = segs[i];
        let node = level.get(name);
        if (!node) {
          node = {
            name,
            type: isLeaf ? 'file' : 'folder',
            fileType: isLeaf ? entry.fileType : undefined,
            children: new Map(),
          };
          level.set(name, node);
        }
        level = node.children;
      }
    }

    const toNodes = (level: Map<string, MutableNode>): DetectedFolderNode[] => {
      return [...level.values()]
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1))
        .slice(0, maxChildren)
        .map((n) => {
          const node: DetectedFolderNode = { name: n.name, type: n.type };
          if (n.fileType) node.fileType = n.fileType;
          if (n.children.size > 0) node.children = toNodes(n.children);
          return node;
        });
    };

    return toNodes(root);
  }

  private async guessArtist(
    entries: FileManifest['entries'],
    originalFilename: string,
    libraryId: string,
  ): Promise<string | null> {
    // Candidate names: the top-level folder, and the archive filename stem.
    const candidates: string[] = [];
    const firstWithDir = entries.find((e) => e.relativePath.includes('/'));
    if (firstWithDir) candidates.push(firstWithDir.relativePath.split('/')[0]);
    candidates.push(stripArchiveExtension(originalFilename));

    let existing: string[] = [];
    try {
      existing = (await metadataService.listFieldValues('artist', libraryId)).map((v) => v.value);
    } catch {
      existing = [];
    }
    const existingLower = new Map(existing.map((v) => [v.toLowerCase(), v]));

    for (const candidate of candidates) {
      const humanized = this.humanize(candidate);
      const match = existingLower.get(humanized.toLowerCase());
      if (match) return match;
    }
    // No existing artist matched — offer a humanized guess if it looks name-like.
    const guess = this.humanize(candidates[0] ?? '');
    return /[a-z]/i.test(guess) ? guess : null;
  }

  private async guessTags(
    entries: FileManifest['entries'],
    libraryId: string,
  ): Promise<string[]> {
    let existing: string[] = [];
    try {
      existing = (await metadataService.listFieldValues('tags', libraryId)).map((v) => v.value);
    } catch {
      existing = [];
    }
    if (existing.length === 0) return [];
    const existingLower = new Map(existing.map((v) => [v.toLowerCase(), v]));

    const tokens = new Set<string>();
    for (const e of entries) {
      for (const seg of e.relativePath.split(/[/\\]/)) {
        for (const token of seg.toLowerCase().split(/[\s._-]+/)) {
          if (token.length >= 3 && !TAG_STOPWORDS.has(token) && !/^\d+$/.test(token)) {
            tokens.add(token);
          }
        }
      }
    }

    const matched: string[] = [];
    for (const token of tokens) {
      const canonical = existingLower.get(token);
      if (canonical && !matched.includes(canonical)) {
        matched.push(canonical);
        if (matched.length >= 8) break;
      }
    }
    return matched;
  }

  private humanize(raw: string): string {
    return raw
      .replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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

      // Step 1: Extract archive and classify files
      const manifest = await fileProcessingService.processArchive(tempFilePath, extractDir);
      await job.updateProgress(20);
      logger.info({ modelId, jobId, fileCount: manifest.entries.length }, 'Archive extracted');

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
    libraryId: string,
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
      deleteAfterUpload: importConfig.deleteAfterUpload ?? importConfig.strategy === 'move',
      userId,
      libraryId,
    });

    logger.info(
      { jobId, sourcePath: importConfig.sourcePath, pattern: importConfig.pattern },
      'Folder import job enqueued',
    );
    return { jobId };
  }

  async processFolderImportJob(
    job: Job<FolderImportJobPayload>,
  ): Promise<void> {
    const { sourcePath, pattern, strategy, deleteAfterUpload, userId, libraryId } = job.data;
    const parsedPattern = parsePattern(pattern);
    const importStrategy = isLocalStorageService(storageService)
      ? createImportStrategy(strategy)
      : null;

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
      const verifiedSources = new Map<string, VerifiedImportSource>();

      for (const model of discovered) {
        try {
          const sources = await this.processDiscoveredModel(
            model,
            importStrategy,
            userId,
            libraryId,
          );
          for (const source of sources) {
            verifiedSources.set(source.filePath, source);
          }
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

      if (storageService.kind === 's3' && deleteAfterUpload && failed === 0) {
        const deletionResults = await Promise.allSettled(
          [...verifiedSources.values()].map((source) => this.deleteVerifiedSource(source)),
        );
        const deletionFailures = deletionResults.filter((result) => result.status === 'rejected');
        if (deletionFailures.length > 0) {
          logger.error(
            {
              jobId: job.id,
              failedSourceDeletions: deletionFailures.length,
              errors: deletionFailures.map((result) => String(result.reason)),
            },
            'Remote import completed, but some verified sources were retained',
          );
        }
        logger.info(
          {
            jobId: job.id,
            deletedSourceFiles: deletionResults.length - deletionFailures.length,
            retainedSourceFiles: deletionFailures.length,
          },
          'Remote import source deletion pass complete',
        );
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
    fileInputs: Array<{ fileType: string; relativePath: string; sourceRelativePath?: string }>,
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

    const imageFiles = fileInputs
      .map((fileInput, index) => ({ fileInput, createdFile: createdFiles[index] }))
      .filter(({ fileInput }) => fileInput.fileType === 'image');

    // Every image is independent and each one is two small uploads, which on a
    // remote backend is almost entirely request round trip. Running them in a
    // bounded batch keeps the resize work overlapped with those waits.
    await forEachWithConcurrency(
      imageFiles,
      uploadConcurrencyFor(storageService),
      async ({ fileInput, createdFile }) => {
        const sourcePath = path.join(
          sourceDir,
          fileInput.sourceRelativePath ?? fileInput.relativePath,
        );
        try {
          const thumbnailRecords = await thumbnailService.generateThumbnails(
            sourcePath,
            modelId,
            createdFile.id,
          );
          allThumbnailRecords.push(...thumbnailRecords);
        } catch (err) {
          logger.warn(
            { modelId, fileId: createdFile.id, path: fileInput.relativePath, error: String(err) },
            'Thumbnail generation failed for file (non-fatal)',
          );
        }
      },
    );

    const imageCount = fileInputs.filter((f) => f.fileType === 'image').length;
    if (imageCount > 0 && allThumbnailRecords.length === 0) {
      logger.error(
        { modelId, imageCount },
        'Thumbnail generation failed for all image files — model will have no thumbnails',
      );
    }

    await modelService.createThumbnails(allThumbnailRecords);
  }

  private async processDiscoveredModel(
    discovered: import('./file-processing.service.js').DiscoveredModel,
    importStrategy: import('./import-strategy.service.js').IImportStrategy | null,
    userId: string,
    libraryId: string,
  ): Promise<VerifiedImportSource[]> {
    const slug = generateSlug(discovered.name);

    // Create model record in processing state. libraryId comes from the job
    // payload which was captured at request time from request.libraryId.
    const { id: modelId } = await modelService.createModel({
      name: discovered.name,
      slug,
      userId,
      libraryId,
      sourceType: 'folder_import',
      status: 'processing',
    });
    const storedPaths: string[] = [];
    let filesPersisted = false;

    try {
      // Scan files in the model's source directory
      const entries = await fileProcessingService.scanDirectory(
        discovered.sourcePath,
        discovered.sourcePath,
      );
      const totalSizeBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);

      const verifiedSources: VerifiedImportSource[] = [];
      await forEachWithConcurrency(
        entries,
        uploadConcurrencyFor(storageService),
        async (entry) => {
          const sourceFilePath = path.join(discovered.sourcePath, entry.relativePath);
          const storagePath = `models/${modelId}/${entry.relativePath}`;

          if (isLocalStorageService(storageService)) {
            if (!importStrategy) {
              throw storageError('Local folder import strategy is unavailable');
            }
            await importStrategy.execute(
              sourceFilePath,
              storageService.resolveStoragePath(storagePath),
            );
            return;
          }

          // Registered before the upload starts: a write that fails or fails
          // verification may still have left an object behind, and the cleanup
          // path needs to know about it.
          storedPaths.push(storagePath);

          // Hashing happens as the bytes stream out, so the source is only
          // deleted after both its SHA-256 and the provider's ETag confirm the
          // upload — with no second trip to fetch the object back.
          await storeVerified(
            storageService,
            storagePath,
            () => fs.createReadStream(sourceFilePath),
            { expectedSha256: entry.hash, expectedSize: entry.sizeBytes },
          );
          verifiedSources.push({
            filePath: sourceFilePath,
            hash: entry.hash,
            sizeBytes: entry.sizeBytes,
          });
        },
      );

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
      filesPersisted = true;

      // Generate thumbnails for image files
      await this.generateAndStoreThumbnails(
        modelId,
        modelFileInputs,
        createdFiles,
        discovered.sourcePath,
      );

      // Assign metadata from pattern
      if (Object.keys(discovered.metadata).length > 0) {
        await metadataService.setModelMetadata(modelId, discovered.metadata);
      }

      // Assign collection from pattern. Pass the job's libraryId so the
      // collection is created in the same library as the model.
      if (discovered.collectionName) {
        const collection = await collectionService.findOrCreateByName(
          discovered.collectionName,
          userId,
          libraryId,
        );
        await collectionService.addModelToCollection(collection.id, modelId);
      }

      // Update model to ready
      await modelService.updateModelStatus(modelId, 'ready', {
        totalSizeBytes,
        fileCount: entries.length,
      });

      logger.info({ modelId, name: discovered.name }, 'Model imported successfully');
      return verifiedSources;
    } catch (err) {
      if (storageService.kind === 's3' && !filesPersisted) {
        await Promise.all(
          storedPaths.map((storedPath) => storageService.delete(storedPath).catch(() => {})),
        );
      }
      await modelService.updateModelStatus(modelId, 'error');
      throw err;
    }
  }

  private async deleteVerifiedSource(source: VerifiedImportSource): Promise<void> {
    const digest = await this.digestStream(fs.createReadStream(source.filePath));
    if (digest.sizeBytes !== source.sizeBytes || digest.hash !== source.hash) {
      throw storageError(`Source changed after remote verification: ${source.filePath}`);
    }
    await fsPromises.unlink(source.filePath);
  }

  private async digestStream(
    stream: NodeJS.ReadableStream,
  ): Promise<{ hash: string; sizeBytes: number }> {
    const hash = createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      sizeBytes += buffer.length;
    }
    return { hash: hash.digest('hex'), sizeBytes };
  }
}

export const ingestionService = new IngestionService();
