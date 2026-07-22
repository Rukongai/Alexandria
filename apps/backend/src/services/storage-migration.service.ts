import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { IStorageService } from './storage.service.js';
import { LocalStorageService } from './storage.service.js';

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
  const files = await listFiles(source.getStorageRoot());
  let copied = 0;
  let skipped = 0;

  for (const [index, file] of files.entries()) {
    const sourceDigest = await digestFile(file.absolutePath);
    let status: StorageMigrationProgress['status'] = 'copied';

    if (await target.exists(file.key)) {
      const targetDigest = await digestStoredObject(target, file.key);
      if (digestsMatch(sourceDigest, targetDigest)) {
        status = 'skipped';
      }
    }

    if (status === 'copied') {
      await target.store(file.key, fs.createReadStream(file.absolutePath));
      const targetDigest = await digestStoredObject(target, file.key);
      if (!digestsMatch(sourceDigest, targetDigest)) {
        await target.delete(file.key).catch(() => {});
        throw new Error(`Storage migration verification failed for ${file.key}`);
      }
      copied++;
    } else {
      skipped++;
    }

    onProgress({
      key: file.key,
      current: index + 1,
      total: files.length,
      status,
    });
  }

  return { copied, skipped, total: files.length };
}

async function listFiles(
  root: string,
): Promise<Array<{ absolutePath: string; key: string }>> {
  const files: Array<{ absolutePath: string; key: string }> = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fsPromises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && directory === root) return;
      throw error;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
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
