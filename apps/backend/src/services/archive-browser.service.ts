import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { ArchiveContents, ArchiveEntry } from '@alexandria/shared';
import { detectArchiveExtension } from '../utils/archive.js';
import { notFound, validationError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { FileProcessingService, fileProcessingService } from './file-processing.service.js';
import { ModelService, modelService } from './model.service.js';
import { type IStorageService, storageService } from './storage.service.js';

const logger = createLogger('ArchiveBrowserService');

export interface ArchiveEntryDownload {
  filename: string;
  sizeBytes: number;
  stream: Readable;
}

/**
 * Reads stored archives without persisting their contents. FileProcessingService
 * remains authoritative for safe archive extraction; this service only composes
 * model authorization, managed storage, and temporary lifecycle cleanup.
 */
export class ArchiveBrowserService {
  constructor(
    private readonly models: ModelService = modelService,
    private readonly storage: IStorageService = storageService,
    private readonly fileProcessing: FileProcessingService = fileProcessingService,
  ) {}

  async list(modelId: string, fileId: string, libraryId: string): Promise<ArchiveContents> {
    const prepared = await this.prepare(modelId, fileId, libraryId);
    try {
      return { entries: this.buildEntries(prepared.manifest.entries) };
    } finally {
      await this.cleanup(prepared.tempDir);
    }
  }

  async download(
    modelId: string,
    fileId: string,
    libraryId: string,
    requestedPath: string,
  ): Promise<ArchiveEntryDownload> {
    const normalizedPath = this.normalizeEntryPath(requestedPath);
    const prepared = await this.prepare(modelId, fileId, libraryId);
    const entry = prepared.manifest.entries.find(
      (candidate) => this.toArchivePath(candidate.relativePath) === normalizedPath,
    );
    if (!entry) {
      await this.cleanup(prepared.tempDir);
      throw notFound(`Archive entry not found: ${normalizedPath}`);
    }

    const sourcePath = path.resolve(prepared.extractDir, ...normalizedPath.split('/'));
    if (!sourcePath.startsWith(`${prepared.extractDir}${path.sep}`)) {
      await this.cleanup(prepared.tempDir);
      throw validationError('Archive entry path is unsafe', 'path');
    }

    const stream = fs.createReadStream(sourcePath);
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      void this.cleanup(prepared.tempDir);
    };
    stream.once('close', cleanup);
    stream.once('error', cleanup);

    return {
      filename: path.posix.basename(normalizedPath),
      sizeBytes: entry.sizeBytes,
      stream,
    };
  }

  private async prepare(modelId: string, fileId: string, libraryId: string): Promise<{
    tempDir: string;
    extractDir: string;
    manifest: Awaited<ReturnType<FileProcessingService['processArchive']>>;
  }> {
    await this.models.requireModelInLibrary(modelId, libraryId);
    const file = (await this.models.getModelFiles(modelId)).find((candidate) => candidate.id === fileId);
    if (!file) throw notFound(`Model file not found: ${fileId}`);
    const archiveFilename = path.basename(file.filename.replaceAll('\\', '/'));
    if (!detectArchiveExtension(archiveFilename)) {
      throw validationError('Model file is not a supported archive');
    }

    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'alexandria-archive-'));
    const archivePath = path.join(tempDir, archiveFilename);
    const extractDir = path.join(tempDir, 'contents');
    try {
      await pipeline(await this.storage.retrieveStream(file.storagePath), fs.createWriteStream(archivePath));
      const manifest = await this.fileProcessing.processArchive(archivePath, extractDir);
      return { tempDir, extractDir: path.resolve(extractDir), manifest };
    } catch (error) {
      await this.cleanup(tempDir);
      throw error;
    }
  }

  private buildEntries(files: Array<{ relativePath: string; sizeBytes: number }>): ArchiveEntry[] {
    const entries = new Map<string, ArchiveEntry>();
    for (const file of files) {
      const filePath = this.toArchivePath(file.relativePath);
      entries.set(filePath, { path: filePath, sizeBytes: file.sizeBytes, isDirectory: false });
      const parts = filePath.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        const directoryPath = parts.slice(0, index).join('/');
        entries.set(directoryPath, { path: directoryPath, sizeBytes: 0, isDirectory: true });
      }
    }
    return [...entries.values()].sort((a, b) => (
      a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }) || Number(b.isDirectory) - Number(a.isDirectory)
    ));
  }

  private normalizeEntryPath(input: string): string {
    const normalized = input.replaceAll('\\', '/').trim();
    const segments = normalized.split('/');
    if (
      !normalized
      || normalized.startsWith('/')
      || /^[a-z]:\//i.test(normalized)
      || segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\0-\x1f]/.test(segment))
    ) {
      throw validationError('Archive entry path is invalid', 'path');
    }
    return normalized;
  }

  private toArchivePath(relativePath: string): string {
    return relativePath.replaceAll('\\', '/').split(path.sep).join('/');
  }

  private async cleanup(tempDir: string): Promise<void> {
    await fsPromises.rm(tempDir, { recursive: true, force: true }).catch((error: unknown) => {
      logger.warn({ tempDir, error: String(error) }, 'Failed to remove archive preview temporary directory');
    });
  }
}

export const archiveBrowserService = new ArchiveBrowserService();
