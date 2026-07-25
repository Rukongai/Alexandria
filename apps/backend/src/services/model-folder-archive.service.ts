import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { CompressFolderResponse } from '@alexandria/shared';
import { conflict, notFound } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { FileProcessingService, fileProcessingService } from './file-processing.service.js';
import { ModelService, modelService } from './model.service.js';
import {
  type IStorageService,
  storageService,
  storeVerified,
} from './storage.service.js';

const logger = createLogger('ModelFolderArchiveService');

export class ModelFolderArchiveService {
  private readonly activeCompressions = new Map<string, Promise<void>>();
  private activeCompressionCount = 0;
  private readonly compressionWaiters: Array<() => void> = [];

  constructor(
    private readonly models: ModelService = modelService,
    private readonly storage: IStorageService = storageService,
    private readonly fileProcessing: FileProcessingService = fileProcessingService,
    private readonly maxConcurrentCompressions = 1,
  ) {}

  async compressFolder(modelId: string, requestedPath: string): Promise<CompressFolderResponse> {
    const folderPath = this.models.normalizeFolderPath(requestedPath);
    const archivePath = this.models.normalizeFolderPath(`${folderPath}.7z`);
    const operationKey = `${modelId}:${archivePath}`;
    const previous = this.activeCompressions.get(operationKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.activeCompressions.set(operationKey, tail);

    await previous;
    const releaseCompressionPermit = await this.acquireCompressionPermit();
    try {
      return await this.compressFolderLocked(modelId, folderPath, archivePath);
    } finally {
      releaseCompressionPermit();
      release();
      if (this.activeCompressions.get(operationKey) === tail) {
        this.activeCompressions.delete(operationKey);
      }
    }
  }

  private async compressFolderLocked(
    modelId: string,
    folderPath: string,
    archivePath: string,
  ): Promise<CompressFolderResponse> {
    const prefix = `${folderPath}/`;
    const [files, folders] = await Promise.all([
      this.models.getModelFiles(modelId),
      this.models.getModelFolders(modelId),
    ]);

    const sourceFiles = files.filter((file) => file.relativePath.startsWith(prefix));
    const sourceFolders = folders.filter(
      (folder) => folder.path === folderPath || folder.path.startsWith(prefix),
    );
    if (sourceFiles.length === 0 && sourceFolders.length === 0) {
      throw notFound(`Folder not found: ${folderPath}`);
    }

    const archivePrefix = `${archivePath}/`;
    if (
      files.some(
        (file) => file.relativePath === archivePath || file.relativePath.startsWith(archivePrefix),
      ) ||
      folders.some(
        (folder) => folder.path === archivePath || folder.path.startsWith(archivePrefix),
      )
    ) {
      throw conflict(`A file or folder already exists at ${archivePath}`);
    }

    const destinationStoragePath = `models/${modelId}/${archivePath}`;
    if (await this.storage.exists(destinationStoragePath)) {
      throw conflict(`A storage object already exists at ${archivePath}`);
    }

    const tempRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'alexandria-folder-archive-'),
    );
    const stageRoot = path.join(tempRoot, 'contents');
    const tempArchivePath = path.join(tempRoot, 'archive.7z');
    let storageWriteAttempted = false;
    let archivePersisted = false;

    try {
      await fsPromises.mkdir(stageRoot, { recursive: true });

      for (const folder of sourceFolders) {
        if (folder.path === folderPath) continue;
        await fsPromises.mkdir(this.stagePath(stageRoot, folder.path.slice(prefix.length)), {
          recursive: true,
        });
      }

      for (const file of sourceFiles) {
        const stagedPath = this.stagePath(stageRoot, file.relativePath.slice(prefix.length));
        await fsPromises.mkdir(path.dirname(stagedPath), { recursive: true });
        await pipeline(
          await this.storage.retrieveStream(file.storagePath),
          fs.createWriteStream(stagedPath),
        );
      }

      await this.fileProcessing.create7zArchive(stageRoot, tempArchivePath);
      const expectedSize = (await fsPromises.stat(tempArchivePath)).size;
      storageWriteAttempted = true;
      const stored = await storeVerified(
        this.storage,
        destinationStoragePath,
        () => fs.createReadStream(tempArchivePath),
        { expectedSize },
      );

      const created = await this.models.createModelFileAndRecalculateStats(modelId, {
        filename: path.posix.basename(archivePath),
        relativePath: archivePath,
        fileType: 'other',
        mimeType: 'application/x-7z-compressed',
        sizeBytes: stored.sizeBytes,
        storagePath: destinationStoragePath,
        hash: stored.sha256,
      });
      archivePersisted = true;

      logger.info(
        { modelId, folderPath, archivePath, sizeBytes: stored.sizeBytes },
        'Compressed model folder',
      );
      return {
        archiveFileId: created.id,
        archivePath,
        sizeBytes: stored.sizeBytes,
      };
    } catch (error) {
      if (storageWriteAttempted && !archivePersisted) {
        await this.storage.delete(destinationStoragePath).catch((cleanupError) => {
          logger.warn(
            { modelId, archivePath, error: String(cleanupError) },
            'Failed to remove incomplete folder archive from storage',
          );
        });
      }
      throw error;
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true }).catch((cleanupError) => {
        logger.warn(
          { modelId, folderPath, tempRoot, error: String(cleanupError) },
          'Failed to remove folder archive staging directory',
        );
      });
    }
  }

  private stagePath(stageRoot: string, relativePath: string): string {
    const destination = path.resolve(stageRoot, ...relativePath.split('/'));
    const root = path.resolve(stageRoot);
    if (!destination.startsWith(`${root}${path.sep}`)) {
      throw conflict('Folder contents contain an unsafe path');
    }
    return destination;
  }

  private acquireCompressionPermit(): Promise<() => void> {
    return new Promise((resolve) => {
      const start = () => {
        this.activeCompressionCount += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.activeCompressionCount -= 1;
          this.compressionWaiters.shift()?.();
        });
      };

      if (this.activeCompressionCount < this.maxConcurrentCompressions) {
        start();
      } else {
        this.compressionWaiters.push(start);
      }
    });
  }
}

export const modelFolderArchiveService = new ModelFolderArchiveService();
