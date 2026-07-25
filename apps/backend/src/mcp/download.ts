import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { IStorageService } from '../services/storage.service.js';
import { conflict, validationError } from '../utils/errors.js';

export interface DownloadableModelFile {
  id: string;
  relativePath: string;
  storagePath: string;
  sizeBytes: number;
}

export interface DownloadedModelFile {
  fileId: string;
  relativePath: string;
  destinationPath: string;
  sizeBytes: number;
}

function safeSegments(value: string, field: string): string[] {
  const normalized = value.replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value)) {
    throw validationError(`${field} must be relative`, field);
  }

  const segments = normalized.split('/');
  if (
    segments.length === 0
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw validationError(`${field} cannot contain empty, . or .. path segments`, field);
  }
  if (segments.some((segment) => /[\0-\x1f]/.test(segment))) {
    throw validationError(`${field} contains unsupported control characters`, field);
  }
  return segments;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertTrustedDirectory(stats: Awaited<ReturnType<typeof fs.lstat>>, candidate: string) {
  if (process.getuid !== undefined && stats.uid !== process.getuid()) {
    throw validationError(
      `Download directory must be owned by the MCP process user: ${candidate}`,
      'downloadDirectory',
    );
  }
  if (process.platform !== 'win32' && (Number(stats.mode) & 0o022) !== 0) {
    throw validationError(
      `Download directory cannot be group- or world-writable: ${candidate}`,
      'downloadDirectory',
    );
  }
}

async function assertTrustedAncestorChain(candidate: string): Promise<void> {
  const processUserId = process.getuid?.();
  let current = path.dirname(candidate);
  while (true) {
    const stats = await fs.lstat(current);
    const mode = Number(stats.mode);
    const writableByAnotherAccount = (mode & 0o022) !== 0;
    const sticky = (mode & 0o1000) !== 0;
    const ownerCanReplaceEntries = (mode & 0o200) !== 0;
    const trustedOwner = processUserId === undefined
      || stats.uid === processUserId
      || stats.uid === 0;
    if ((writableByAnotherAccount && !sticky) || (!trustedOwner && ownerCanReplaceEntries)) {
      throw validationError(
        `Download directory has an unsafe writable ancestor: ${current}`,
        'downloadDirectory',
      );
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function assertDirectory(root: string, candidate: string): Promise<string> {
  const stats = await fs.lstat(candidate);
  if (stats.isSymbolicLink()) {
    throw validationError('Download destination cannot traverse symbolic links', 'subdirectory');
  }
  if (!stats.isDirectory()) {
    throw conflict(`Download destination is not a directory: ${candidate}`);
  }
  assertTrustedDirectory(stats, candidate);

  const real = await fs.realpath(candidate);
  if (!isInside(root, real)) {
    throw validationError('Download destination escapes the configured directory', 'subdirectory');
  }
  return real;
}

async function ensureSafeDirectory(root: string, segments: string[]): Promise<string> {
  let current = root;
  for (const segment of segments) {
    const next = path.join(current, segment);
    try {
      await fs.mkdir(next, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    current = await assertDirectory(root, next);
  }
  return current;
}

async function destinationExists(destinationPath: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(destinationPath);
    if (stats.isSymbolicLink()) {
      throw validationError('Download destination cannot be a symbolic link', 'subdirectory');
    }
    if (!stats.isFile()) {
      throw conflict(`Download destination is not a regular file: ${destinationPath}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function downloadModelFiles(options: {
  downloadDirectory: string;
  subdirectory: string;
  files: DownloadableModelFile[];
  overwrite: boolean;
  storage: Pick<IStorageService, 'retrieveStream'>;
}): Promise<DownloadedModelFile[]> {
  const subdirectorySegments = safeSegments(options.subdirectory, 'subdirectory');
  const configuredRoot = path.resolve(options.downloadDirectory);
  let configuredRootStats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    configuredRootStats = await fs.lstat(configuredRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw validationError(
        'ALEXANDRIA_MCP_DOWNLOAD_DIR must exist before downloading files',
        'downloadDirectory',
      );
    }
    throw error;
  }
  if (configuredRootStats.isSymbolicLink()) {
    throw validationError('Download directory cannot be a symbolic link', 'downloadDirectory');
  }
  const root = await fs.realpath(configuredRoot);
  const configuredRootAfterRealpath = await fs.lstat(configuredRoot);
  if (
    configuredRootStats.dev !== configuredRootAfterRealpath.dev
    || configuredRootStats.ino !== configuredRootAfterRealpath.ino
  ) {
    throw validationError('Download directory changed while it was being validated', 'downloadDirectory');
  }
  await assertTrustedAncestorChain(root);
  await assertDirectory(root, root);
  const baseDirectory = await ensureSafeDirectory(root, subdirectorySegments);

  const destinations = options.files.map((file) => {
    const segments = safeSegments(file.relativePath, 'relativePath');
    return { file, segments };
  });

  // Validate every destination before downloading any bytes. Treat
  // case/Unicode-normalization variants as collisions too, keeping behavior
  // portable across case-sensitive and case-insensitive filesystems.
  const destinationKeys = new Set<string>();
  const prepared: Array<{
    file: DownloadableModelFile;
    segments: string[];
    parent: string;
    destinationPath: string;
    temporaryPath?: string;
  }> = [];
  for (const { file, segments } of destinations) {
    const parent = await ensureSafeDirectory(baseDirectory, segments.slice(0, -1));
    const destinationPath = path.join(parent, segments.at(-1)!);
    const destinationKey = destinationPath.normalize('NFC').toLocaleLowerCase('en-US');
    if (destinationKeys.has(destinationKey)) {
      throw conflict(`Multiple model files resolve to the same download path: ${destinationPath}`);
    }
    destinationKeys.add(destinationKey);
    if ((await destinationExists(destinationPath)) && !options.overwrite) {
      throw conflict(`Refusing to overwrite existing file: ${destinationPath}`);
    }
    prepared.push({
      file,
      segments,
      parent,
      destinationPath,
    });
  }

  // Retrieve every object into a private temporary file before making any
  // destination visible. A failed stream therefore cannot yield a partial set.
  try {
    for (const item of prepared) {
      await assertDirectory(root, item.parent);
      item.temporaryPath = path.join(item.parent, `.alexandria-${randomUUID()}.tmp`);
      const source = await options.storage.retrieveStream(item.file.storagePath);
      const handle = await fs.open(
        item.temporaryPath,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_NOFOLLOW,
        0o600,
      );
      await pipeline(source, handle.createWriteStream());
    }
  } catch (error) {
    await Promise.allSettled(
      prepared.flatMap((item) => item.temporaryPath ? [fs.unlink(item.temporaryPath)] : []),
    );
    throw error;
  }

  if (!options.overwrite) {
    const promoted: string[] = [];
    try {
      for (const item of prepared) {
        try {
          await fs.link(item.temporaryPath!, item.destinationPath);
          promoted.push(item.destinationPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw conflict(`Refusing to overwrite existing file: ${item.destinationPath}`);
          }
          throw error;
        }
      }
    } catch (error) {
      await Promise.allSettled(promoted.map((destinationPath) => fs.unlink(destinationPath)));
      throw error;
    } finally {
      await Promise.allSettled(prepared.map((item) => fs.unlink(item.temporaryPath!)));
    }
  } else {
    const backups = new Map<string, string>();
    const promoted: string[] = [];
    try {
      // Move existing regular files aside first so every replacement can be
      // restored if a later promotion fails.
      for (const item of prepared) {
        if (await destinationExists(item.destinationPath)) {
          const backupPath = path.join(item.parent, `.alexandria-${randomUUID()}.bak`);
          await fs.rename(item.destinationPath, backupPath);
          backups.set(item.destinationPath, backupPath);
        }
      }
      for (const item of prepared) {
        await fs.rename(item.temporaryPath!, item.destinationPath);
        promoted.push(item.destinationPath);
      }
    } catch (error) {
      await Promise.allSettled(promoted.map((destinationPath) => fs.unlink(destinationPath)));
      await Promise.allSettled(
        [...backups].map(([destinationPath, backupPath]) =>
          fs.rename(backupPath, destinationPath)),
      );
      throw error;
    } finally {
      await Promise.allSettled(prepared.map((item) => fs.unlink(item.temporaryPath!)));
    }
    await Promise.allSettled([...backups.values()].map((backupPath) => fs.unlink(backupPath)));
  }

  return prepared.map(({ file, segments, destinationPath }) => ({
    fileId: file.id,
    relativePath: segments.join('/'),
    destinationPath,
    sizeBytes: file.sizeBytes,
  }));
}
