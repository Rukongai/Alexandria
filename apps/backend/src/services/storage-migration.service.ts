import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  config,
  S3_THUMBNAIL_CACHE_RELATIVE_PATH,
} from '../config/index.js';
import { forEachWithConcurrency } from '../utils/concurrency.js';
import type { IStorageService } from './storage.service.js';
import {
  LocalStorageService,
  storeVerified,
  uploadConcurrencyFor,
} from './storage.service.js';

export interface StorageMigrationProgress {
  key: string;
  current: number;
  total: number;
  status: 'copied' | 'skipped';
}

export interface StorageMigrationResult {
  copied: number;
  skipped: number;
  total: number;
}

interface ObjectDigest {
  hash: string;
  size: number;
}

export async function migrateLocalStorage(
  source: LocalStorageService,
  target: IStorageService,
  onProgress: (progress: StorageMigrationProgress) => void = () => {},
): Promise<StorageMigrationResult> {
  const root = source.getStorageRoot();
  const files = await listFiles(root, [
    path.resolve(root, S3_THUMBNAIL_CACHE_RELATIVE_PATH),
    path.resolve(config.s3ThumbnailCachePath),
  ]);
  let copied = 0;
  let skipped = 0;
  let processed = 0;

  await forEachWithConcurrency(files, uploadConcurrencyFor(target), async (file) => {
    let status: StorageMigrationProgress['status'] = 'copied';

    if (await target.exists(file.key)) {
      // An object already at the target is the one case that still justifies
      // reading bytes back: nothing local records what a previous run uploaded.
      const sourceDigest = await digestFile(file.absolutePath);
      const targetDigest = await digestStoredObject(target, file.key);
      if (digestsMatch(sourceDigest, targetDigest)) {
        status = 'skipped';
      }
    }

    if (status === 'copied') {
      // Verification now rides along with the upload: the source is hashed as
      // it streams and checked against the ETag the provider reports, so a
      // migration no longer moves every byte twice.
      try {
        await storeVerified(target, file.key, () => fs.createReadStream(file.absolutePath));
      } catch (error) {
        // Leave nothing half-written behind, so a re-run starts from a clean
        // target rather than skipping a corrupt object it thinks it copied.
        await target.delete(file.key).catch(() => {});
        throw error;
      }
      copied += 1;
    } else {
      skipped += 1;
    }

    // Files complete out of order once uploads overlap, so `current` counts how
    // many have finished rather than indexing into the file list.
    processed += 1;
    onProgress({ key: file.key, current: processed, total: files.length, status });
  });

  return { copied, skipped, total: files.length };
}

async function listFiles(
  root: string,
  excludedDirectories: string[],
): Promise<Array<{ absolutePath: string; key: string }>> {
  const files: Array<{ absolutePath: string; key: string }> = [];
  const excluded = new Set(excludedDirectories.map((directory) => path.resolve(directory)));

  async function walk(directory: string): Promise<void> {
    const entries = await fsPromises.readdir(directory, { withFileTypes: true });

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (excluded.has(path.resolve(absolutePath))) continue;
        await walk(absolutePath);
      } else if (entry.isFile()) {
        const key = path.relative(root, absolutePath).split(path.sep).join('/');
        files.push({ absolutePath, key });
      }
    }
  }

  await walk(root);
  return files;
}

async function digestFile(filePath: string): Promise<ObjectDigest> {
  return digestStream(fs.createReadStream(filePath));
}

async function digestStoredObject(
  storage: IStorageService,
  key: string,
): Promise<ObjectDigest> {
  return digestStream(await storage.retrieveStream(key));
}

async function digestStream(stream: NodeJS.ReadableStream): Promise<ObjectDigest> {
  const hash = createHash('sha256');
  let size = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    size += buffer.length;
  }

  return { hash: hash.digest('hex'), size };
}

function digestsMatch(left: ObjectDigest, right: ObjectDigest): boolean {
  return left.size === right.size && left.hash === right.hash;
}
