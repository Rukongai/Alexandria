import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import type { FileType } from '@alexandria/shared';
import {
  SUPPORTED_IMAGE_FORMATS,
  SUPPORTED_DOCUMENT_FORMATS,
  STL_EXTENSIONS,
} from '@alexandria/shared';
import type { IStorageService } from './storage.service.js';

export interface FileManifestEntry {
  filename: string;
  relativePath: string;
  fileType: FileType;
  mimeType: string;
  sizeBytes: number;
  hash: string;
}

export interface FileManifest {
  entries: FileManifestEntry[];
  totalSizeBytes: number;
}

const MIME_MAP: Record<string, string> = {
  stl: 'model/stl',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
};

function classifyExtension(ext: string): FileType {
  const lower = ext.toLowerCase();
  if ((STL_EXTENSIONS as readonly string[]).includes(lower)) return 'stl';
  if ((SUPPORTED_IMAGE_FORMATS as readonly string[]).includes(lower)) return 'image';
  if ((SUPPORTED_DOCUMENT_FORMATS as readonly string[]).includes(lower)) return 'document';
  return 'other';
}

function getMimeType(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

function isHidden(filePath: string): boolean {
  return filePath.split('/').some((part) => part.startsWith('.'));
}

function isMacos(filePath: string): boolean {
  return filePath.split('/').some((part) => part === '__MACOSX');
}

async function computeHashAndSize(
  filePath: string,
): Promise<{ hash: string; sizeBytes: number }> {
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;

  const readStream = fs.createReadStream(filePath);
  readStream.on('data', (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    sizeBytes += buf.length;
    hash.update(buf);
  });

  await new Promise<void>((resolve, reject) => {
    readStream.on('end', resolve);
    readStream.on('error', reject);
  });

  return { hash: hash.digest('hex'), sizeBytes };
}

export interface DiscoveredModel {
  /** Directory name that matched {model} in the pattern */
  name: string;
  /** Absolute path to the model's root directory */
  sourcePath: string;
  /** Collection name extracted from pattern, if any */
  collectionName: string | null;
  /** Metadata key-value pairs extracted from pattern (slug → directory name) */
  metadata: Record<string, string>;
}

export class FileProcessingService {
  /**
   * Walk a source directory matching against a parsed import pattern.
   * Returns a list of discovered models with their metadata/collection context.
   *
   * The pattern segments define the meaning of each directory level:
   *   {Collection}       → the directory name becomes a collection assignment
   *   {metadata.<slug>}  → the directory name becomes a metadata value
   *   {model}            → the directory name becomes the model name; everything below is model content
   */
  async walkDirectoryForImport(
    sourcePath: string,
    parsedPattern: import('@alexandria/shared').ParsedPatternSegment[],
  ): Promise<DiscoveredModel[]> {
    const discovered: DiscoveredModel[] = [];
    await this.walkPatternLevel(sourcePath, parsedPattern, 0, null, {}, discovered);
    return discovered;
  }

  private async walkPatternLevel(
    currentPath: string,
    pattern: import('@alexandria/shared').ParsedPatternSegment[],
    depth: number,
    collectionName: string | null,
    metadata: Record<string, string>,
    results: DiscoveredModel[],
  ): Promise<void> {
    if (depth >= pattern.length) return;

    const segment = pattern[depth];
    let entries: import('node:fs').Dirent[];

    try {
      entries = await fsPromises.readdir(currentPath, { withFileTypes: true });
    } catch {
      return; // directory not accessible, skip
    }

    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));

    for (const dir of dirs) {
      const dirPath = path.join(currentPath, dir.name);

      if (segment.type === 'model') {
        // This directory is a model root
        results.push({
          name: dir.name,
          sourcePath: dirPath,
          collectionName,
          metadata: { ...metadata },
        });
      } else if (segment.type === 'collection') {
        await this.walkPatternLevel(
          dirPath,
          pattern,
          depth + 1,
          dir.name,
          metadata,
          results,
        );
      } else if (segment.type === 'metadata' && segment.metadataSlug) {
        await this.walkPatternLevel(
          dirPath,
          pattern,
          depth + 1,
          collectionName,
          { ...metadata, [segment.metadataSlug]: dir.name },
          results,
        );
      }
    }
  }

  async processZip(zipPath: string, extractDir: string): Promise<FileManifest> {
    await fsPromises.mkdir(extractDir, { recursive: true });

    await this.extractZip(zipPath, extractDir);

    const entries = await this.scanDirectory(extractDir, extractDir);
    const totalSizeBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);

    return { entries, totalSizeBytes };
  }

  private extractZip(zipPath: string, extractDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
        if (err) return reject(err);
        if (!zipfile) return reject(new Error('Failed to open zip file'));

        zipfile.readEntry();

        zipfile.on('entry', (entry: yauzl.Entry) => {
          const fileName: string = entry.fileName;

          // Skip directories, hidden files, and __MACOSX entries
          if (/\/$/.test(fileName) || isHidden(fileName) || isMacos(fileName)) {
            zipfile.readEntry();
            return;
          }

          const destPath = path.join(extractDir, fileName);

          // Guard against zip path traversal (e.g., ../../etc/passwd)
          const resolved = path.resolve(destPath);
          const extractRoot = path.resolve(extractDir);
          if (!resolved.startsWith(extractRoot + path.sep) && resolved !== extractRoot) {
            zipfile.readEntry();
            return;
          }

          const destDir = path.dirname(destPath);

          fsPromises
            .mkdir(destDir, { recursive: true })
            .then(() => {
              zipfile.openReadStream(entry, (streamErr, readStream) => {
                if (streamErr) return reject(streamErr);
                if (!readStream) return reject(new Error('No read stream for entry'));

                const writeStream = fs.createWriteStream(destPath);

                pipeline(readStream, writeStream)
                  .then(() => zipfile.readEntry())
                  .catch(reject);
              });
            })
            .catch(reject);
        });

        zipfile.on('end', () => resolve());
        zipfile.on('error', reject);
      });
    });
  }

  async copyManifestToStorage(
    extractDir: string,
    modelId: string,
    manifest: FileManifest,
    storage: IStorageService,
  ): Promise<void> {
    for (const entry of manifest.entries) {
      const storagePath = `models/${modelId}/${entry.relativePath}`;
      const sourcePath = path.join(extractDir, entry.relativePath);
      const readStream = fs.createReadStream(sourcePath);
      await storage.store(storagePath, readStream);
    }
  }

  async scanDirectory(dir: string, rootDir: string): Promise<FileManifestEntry[]> {
    const entries: FileManifestEntry[] = [];
    const items = await fsPromises.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        const nested = await this.scanDirectory(fullPath, rootDir);
        entries.push(...nested);
      } else if (item.isFile()) {
        const relativePath = path.relative(rootDir, fullPath);

        // Skip hidden files and __MACOSX at scan time too (in case they slipped through)
        if (isHidden(relativePath) || isMacos(relativePath)) continue;

        const ext = path.extname(item.name).replace(/^\./, '').toLowerCase();
        const fileType = classifyExtension(ext);
        const mimeType = getMimeType(ext);
        const { hash, sizeBytes } = await computeHashAndSize(fullPath);

        entries.push({
          filename: item.name,
          relativePath,
          fileType,
          mimeType,
          sizeBytes,
          hash,
        });
      }
    }

    return entries;
  }
}

export const fileProcessingService = new FileProcessingService();
