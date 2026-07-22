import { S3Client } from '@aws-sdk/client-s3';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config, type AppConfig } from '../config/index.js';
import { storageError } from '../utils/errors.js';
import { S3StorageService } from './s3-storage.service.js';
import { validateStorageKey } from './storage-key.js';

export type StorageData = Buffer | Readable;

export interface IStorageService {
  readonly kind: 'local' | 's3';
  store(filePath: string, data: StorageData): Promise<void>;
  retrieve(filePath: string): Promise<Buffer>;
  retrieveStream(filePath: string): Promise<Readable>;
  copy(sourcePath: string, destinationPath: string): Promise<void>;
  delete(filePath: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
}

export class LocalStorageService implements IStorageService {
  readonly kind = 'local' as const;

  private readonly root: string;

  constructor(storagePath: string = config.storagePath) {
    this.root = storagePath;
  }

  getStorageRoot(): string {
    return path.resolve(this.root);
  }

  resolveStoragePath(filePath: string): string {
    return this.resolve(filePath);
  }

  async store(filePath: string, data: StorageData): Promise<void> {
    const absolute = this.resolve(filePath);
    const dir = path.dirname(absolute);

    try {
      await fsPromises.mkdir(dir, { recursive: true });

      if (Buffer.isBuffer(data)) {
        await fsPromises.writeFile(absolute, data);
      } else {
        const writeStream = fs.createWriteStream(absolute);
        await pipeline(data, writeStream);
      }
    } catch (error) {
      throw storageError(`Failed to store file at ${filePath}: ${errorMessage(error)}`);
    }
  }

  async retrieve(filePath: string): Promise<Buffer> {
    const absolute = this.resolve(filePath);
    try {
      return await fsPromises.readFile(absolute);
    } catch (error) {
      throw storageError(`Failed to retrieve file at ${filePath}: ${errorMessage(error)}`);
    }
  }

  async retrieveStream(filePath: string): Promise<Readable> {
    const absolute = this.resolve(filePath);
    try {
      await fsPromises.access(absolute);
      return fs.createReadStream(absolute);
    } catch (error) {
      throw storageError(`Failed to retrieve file at ${filePath}: ${errorMessage(error)}`);
    }
  }

  async copy(sourcePath: string, destinationPath: string): Promise<void> {
    const source = this.resolve(sourcePath);
    const destination = this.resolve(destinationPath);

    try {
      await fsPromises.mkdir(path.dirname(destination), { recursive: true });
      await fsPromises.copyFile(source, destination);
    } catch (error) {
      throw storageError(
        `Failed to copy file from ${sourcePath} to ${destinationPath}: ${errorMessage(error)}`,
      );
    }
  }

  async delete(filePath: string): Promise<void> {
    const absolute = this.resolve(filePath);
    try {
      await fsPromises.unlink(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw storageError(`Failed to delete file at ${filePath}: ${errorMessage(error)}`);
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const absolute = this.resolve(filePath);
    try {
      await fsPromises.access(absolute);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw storageError(`Failed to check file at ${filePath}: ${errorMessage(error)}`);
    }
  }

  private resolve(filePath: string): string {
    validateStorageKey(filePath);
    return path.resolve(this.root, ...filePath.split('/'));
  }
}

export { LocalStorageService as StorageService };

export function isLocalStorageService(
  storage: IStorageService,
): storage is LocalStorageService {
  return storage.kind === 'local';
}

export function createStorageService(appConfig: AppConfig = config): IStorageService {
  if (appConfig.storageBackend === 'local') {
    return new LocalStorageService(appConfig.storagePath);
  }

  if (!appConfig.s3.bucket) {
    throw storageError('S3_BUCKET is required when STORAGE_BACKEND=s3');
  }

  const client = new S3Client({
    endpoint: appConfig.s3.endpoint,
    region: appConfig.s3.region,
    forcePathStyle: appConfig.s3.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  return new S3StorageService({
    client,
    bucket: appConfig.s3.bucket,
    prefix: appConfig.s3.prefix,
  });
}

export const storageService = createStorageService();

export async function validateStorageBackend(
  storage: IStorageService = storageService,
): Promise<void> {
  if (storage instanceof S3StorageService) {
    await storage.validateBucketAccess();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
