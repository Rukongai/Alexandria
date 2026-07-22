import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import * as tar from 'tar';
import { createExtractorFromFile } from 'node-unrar-js';
import Seven from 'node-7z';
import { path7za } from '7zip-bin';
import type { FileType, MultipartArchiveMode } from '@alexandria/shared';
import {
  SUPPORTED_IMAGE_FORMATS,
  SUPPORTED_DOCUMENT_FORMATS,
  STL_EXTENSIONS,
} from '@alexandria/shared';
import { detectArchiveExtension, stripArchiveExtension } from '../utils/archive.js';
import { validationError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import type { IStorageService } from './storage.service.js';

const logger = createLogger('FileProcessingService');

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

export interface MultipartArchiveFile {
  tempFilePath: string;
  originalFilename: string;
}

export interface ValidatedSplitZipSet {
  kind: 'classic' | 'numbered';
  entryFilename: string;
  logicalFilename: string;
}

interface SevenZipListEntry {
  file?: string;
  attributes?: string;
  techInfo?: Map<string, string>;
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

/** Validate and identify the entry member for one complete split-ZIP set. */
export function validateSplitZipSet(files: MultipartArchiveFile[]): ValidatedSplitZipSet {
  const filenames = files.map(({ originalFilename }) => {
    const basename = path.posix.basename(originalFilename.replaceAll('\\', '/'));
    if (basename !== originalFilename) {
      throw validationError('Split ZIP members must use plain filenames');
    }
    return basename;
  });

  const uniqueNames = new Set(filenames.map((filename) => filename.toLowerCase()));
  if (uniqueNames.size !== filenames.length) {
    throw validationError('Split ZIP set contains duplicate members');
  }

  const classicParts: Array<{ filename: string; base: string; index: number }> = [];
  const classicTerminals: Array<{ filename: string; base: string }> = [];
  const numberedParts: Array<{ filename: string; base: string; index: number }> = [];

  for (const filename of filenames) {
    const classicMatch = /^(.*)\.z(\d{2})$/i.exec(filename);
    if (classicMatch) {
      classicParts.push({
        filename,
        base: classicMatch[1],
        index: Number(classicMatch[2]),
      });
      continue;
    }

    const numberedMatch = /^(.*\.zip)\.(\d{3})$/i.exec(filename);
    if (numberedMatch) {
      numberedParts.push({
        filename,
        base: numberedMatch[1],
        index: Number(numberedMatch[2]),
      });
      continue;
    }

    const terminalMatch = /^(.*)\.zip$/i.exec(filename);
    if (terminalMatch) {
      classicTerminals.push({ filename, base: terminalMatch[1] });
      continue;
    }

    throw validationError(`Unrecognized split ZIP member: ${filename}`);
  }

  if (numberedParts.length > 0) {
    if (classicParts.length > 0 || classicTerminals.length > 0) {
      throw validationError('Split ZIP set mixes classic and numbered naming schemes');
    }
    const base = numberedParts[0].base.toLowerCase();
    if (numberedParts.some((part) => part.base.toLowerCase() !== base)) {
      throw validationError('Split ZIP members must share the same base filename');
    }
    const ordered = [...numberedParts].sort((a, b) => a.index - b.index);
    for (let position = 0; position < ordered.length; position += 1) {
      const expected = position + 1;
      if (ordered[position].index !== expected) {
        throw validationError(`Split ZIP set is missing part ${String(expected).padStart(3, '0')}`);
      }
    }
    return {
      kind: 'numbered',
      entryFilename: ordered[0].filename.toLowerCase(),
      logicalFilename: ordered[0].filename.slice(0, -4),
    };
  }

  if (classicParts.length === 0 || classicTerminals.length !== 1) {
    throw validationError('Classic split ZIP set requires .z01 parts and one terminal .zip file');
  }
  const terminal = classicTerminals[0];
  const terminalBase = terminal.base.toLowerCase();
  if (classicParts.some((part) => part.base.toLowerCase() !== terminalBase)) {
    throw validationError('Split ZIP members must share the same base filename');
  }
  const ordered = [...classicParts].sort((a, b) => a.index - b.index);
  for (let position = 0; position < ordered.length; position += 1) {
    const expected = position + 1;
    if (ordered[position].index !== expected) {
      throw validationError(`Split ZIP set is missing part ${String(expected).padStart(2, '0')}`);
    }
  }
  return {
    kind: 'classic',
    entryFilename: terminal.filename.toLowerCase(),
    logicalFilename: terminal.filename,
  };
}

function plainArchiveFilename(filename: string): string {
  const normalized = filename.replaceAll('\\', '/');
  const basename = path.posix.basename(normalized);
  if (basename !== filename || path.posix.isAbsolute(normalized) || /^[a-z]:\//i.test(normalized)) {
    throw validationError('Archive members must use plain filenames');
  }
  return basename;
}

export function validate7zArchiveEntry(entry: SevenZipListEntry): void {
  const filename = entry.file;
  if (!filename) return;
  const normalized = filename.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    normalized.startsWith('/')
    || normalized.startsWith('//')
    || /^[a-z]:\//i.test(normalized)
    || segments.includes('..')
  ) {
    throw validationError(`Archive contains unsafe path: ${filename}`);
  }

  const info = entry.techInfo;
  const symbolicLink = info?.get('Symbolic Link')?.trim();
  const hardLink = info?.get('Hard Link')?.trim();
  const reparse = [...(info?.entries() ?? [])].find(
    ([key, value]) => /reparse/i.test(key) && value.trim() && value.trim() !== '-',
  );
  const mode = info?.get('Mode') ?? '';
  const attributes = info?.get('Attributes') ?? entry.attributes ?? '';
  const unixLinkMode = /(^|\s|\d)l[rwx-]/i;
  if (
    symbolicLink
    || hardLink
    || reparse
    || unixLinkMode.test(mode)
    || unixLinkMode.test(attributes)
    || /reparse/i.test(attributes)
  ) {
    throw validationError(`Archive contains unsupported link or reparse entry: ${filename}`);
  }
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
  validateMultipartArchives(
    files: MultipartArchiveFile[],
    mode: MultipartArchiveMode,
  ): string {
    if (mode === 'split') {
      return validateSplitZipSet(files).logicalFilename;
    }

    for (const file of files) {
      plainArchiveFilename(file.originalFilename);
      if (!detectArchiveExtension(file.originalFilename)) {
        throw validationError(`Unsupported archive format: ${file.originalFilename}`);
      }
    }
    return files[0].originalFilename;
  }

  async processMultipartArchives(
    files: MultipartArchiveFile[],
    extractDir: string,
    mode: MultipartArchiveMode,
  ): Promise<FileManifest> {
    this.validateMultipartArchives(files, mode);

    if (mode === 'split') {
      return this.processSplitZip(files, extractDir);
    }

    const extractRoot = path.resolve(extractDir);
    await fsPromises.mkdir(extractRoot, { recursive: true });
    const occupiedFolderNames = new Set<string>();

    for (const file of files) {
      const basename = plainArchiveFilename(file.originalFilename);
      const stem = stripArchiveExtension(basename);
      if (!stem.trim() || /^\.+$/.test(stem)) {
        throw validationError(`Archive filename cannot produce a safe folder: ${basename}`);
      }
      let folderName = stem;
      for (let suffix = 2; occupiedFolderNames.has(folderName.toLowerCase()); suffix += 1) {
        folderName = `${stem}-${suffix}`;
      }
      occupiedFolderNames.add(folderName.toLowerCase());
      const destination = path.resolve(extractRoot, folderName);
      if (!destination.startsWith(`${extractRoot}${path.sep}`)) {
        throw validationError(`Archive folder is outside the extraction root: ${basename}`);
      }
      await this.processArchive(file.tempFilePath, destination);
    }

    const entries = await this.scanDirectory(extractDir, extractDir);
    return {
      entries,
      totalSizeBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    };
  }

  private async processSplitZip(
    files: MultipartArchiveFile[],
    extractDir: string,
  ): Promise<FileManifest> {
    const { entryFilename } = validateSplitZipSet(files);
    const partsDir = await fsPromises.mkdtemp(path.join(path.dirname(extractDir), 'split-zip-'));

    try {
      await Promise.all(files.map(async (file) => {
        // Normalize case so a set accepted case-insensitively can still be
        // resolved by 7-Zip on a case-sensitive filesystem.
        const basename = path.posix.basename(file.originalFilename).toLowerCase();
        await fsPromises.copyFile(file.tempFilePath, path.join(partsDir, basename));
      }));
      return await this.process7z(path.join(partsDir, entryFilename), extractDir);
    } finally {
      await fsPromises.rm(partsDir, { recursive: true, force: true }).catch(() => {});
    }
  }

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

  /**
   * Dispatch archive extraction to the correct per-format handler based on the filename extension.
   */
  async processArchive(archivePath: string, extractDir: string): Promise<FileManifest> {
    const ext = detectArchiveExtension(path.basename(archivePath));
    if (!ext) {
      throw validationError('Unsupported archive format');
    }
    switch (ext) {
      case '.zip':
        return this.processZip(archivePath, extractDir);
      case '.tar.gz':
      case '.tgz':
        return this.processTarGz(archivePath, extractDir);
      case '.rar':
        return this.processRar(archivePath, extractDir);
      case '.7z':
        return this.process7z(archivePath, extractDir);
      default:
        throw validationError('Unsupported archive format');
    }
  }

  private async processZip(zipPath: string, extractDir: string): Promise<FileManifest> {
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

  private async processTarGz(archivePath: string, extractDir: string): Promise<FileManifest> {
    await fsPromises.mkdir(extractDir, { recursive: true });
    await this.extractTarGz(archivePath, extractDir);
    const entries = await this.scanDirectory(extractDir, extractDir);
    const totalSizeBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
    return { entries, totalSizeBytes };
  }

  private async extractTarGz(archivePath: string, extractDir: string): Promise<void> {
    const extractRoot = path.resolve(extractDir);
    await tar.extract({
      file: archivePath,
      cwd: extractDir,
      follow: false,
      filter: (filePath, entry) => {
        // Reject symlinks and hard links to prevent symlink attacks
        // entry.type is only present on ReadEntry (not Stats), so use 'in' guard
        if ('type' in entry && (entry.type === 'SymbolicLink' || entry.type === 'Link')) return false;
        // Guard path traversal
        const resolved = path.resolve(extractDir, filePath);
        if (!resolved.startsWith(extractRoot + path.sep) && resolved !== extractRoot) {
          return false;
        }
        return !isHidden(filePath) && !isMacos(filePath);
      },
    });
  }

  private async processRar(archivePath: string, extractDir: string): Promise<FileManifest> {
    await fsPromises.mkdir(extractDir, { recursive: true });
    await this.extractRar(archivePath, extractDir);
    const entries = await this.scanDirectory(extractDir, extractDir);
    const totalSizeBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
    return { entries, totalSizeBytes };
  }

  private async extractRar(archivePath: string, extractDir: string): Promise<void> {
    const extractRoot = path.resolve(extractDir);
    const extractor = await createExtractorFromFile({
      filepath: archivePath,
      targetPath: extractDir,
    });
    const { files } = extractor.extract({
      // Filter is evaluated BEFORE extraction — prevents unsafe entries from being written
      files: (fileHeader) => {
        const fileName = fileHeader.name;
        // Skip directories
        if (fileHeader.flags.directory) return false;
        // Skip hidden files and __MACOSX entries
        if (isHidden(fileName) || isMacos(fileName)) return false;
        // Guard path traversal
        const resolved = path.resolve(extractDir, fileName);
        if (!resolved.startsWith(extractRoot + path.sep) && resolved !== extractRoot) return false;
        return true;
      },
    });
    // Consume the generator to trigger disk writes for accepted entries
    for (const _file of files) { /* extraction happens during iteration */ }
  }

  private async process7z(archivePath: string, extractDir: string): Promise<FileManifest> {
    await this.preflight7z(archivePath);
    await fsPromises.mkdir(extractDir, { recursive: true });
    await this.extract7z(archivePath, extractDir);
    const entries = await this.scanDirectory(extractDir, extractDir);
    const totalSizeBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
    return { entries, totalSizeBytes };
  }

  private preflight7z(archivePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = Seven.list(archivePath, { $bin: path7za, techInfo: true });
      let rejected = false;
      stream.on('data', (entry: SevenZipListEntry) => {
        if (rejected) return;
        try {
          validate7zArchiveEntry(entry);
        } catch (error) {
          rejected = true;
          reject(error);
        }
      });
      stream.on('end', () => {
        if (!rejected) resolve();
      });
      stream.on('error', (error) => {
        if (!rejected) reject(error);
      });
    });
  }

  private extract7z(archivePath: string, extractDir: string): Promise<void> {
    const extractRoot = path.resolve(extractDir);
    let unsafeReportedPath: string | null = null;

    return new Promise((resolve, reject) => {
      const stream = Seven.extractFull(archivePath, extractDir, {
        $bin: path7za,
        recursive: true,
      });

      stream.on('data', (entry: { file?: string }) => {
        if (entry.file) {
          const absPath = path.resolve(extractDir, entry.file);
          if (!absPath.startsWith(extractRoot + path.sep) && absPath !== extractRoot) {
            unsafeReportedPath = entry.file;
          }
        }
      });

      stream.on('end', () => {
        if (unsafeReportedPath) {
          logger.warn(
            { archivePath, unsafeReportedPath },
            '7z extraction reported a path outside the extraction root after preflight',
          );
          reject(validationError('Archive extraction escaped the destination'));
          return;
        }
        resolve();
      });

      stream.on('error', reject);
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

      if (item.isSymbolicLink()) {
        // Skip symlinks — defense-in-depth against any extractor that leaks them through
        continue;
      } else if (item.isDirectory()) {
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
