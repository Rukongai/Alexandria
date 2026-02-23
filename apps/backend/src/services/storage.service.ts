import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from '../config/index.js';
import { storageError } from '../utils/errors.js';

export interface IStorageService {
  store(filePath: string, data: Buffer | NodeJS.ReadableStream): Promise<void>;
  retrieve(filePath: string): Promise<Buffer>;
  retrieveStream(filePath: string): NodeJS.ReadableStream;
  delete(filePath: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
}

export class StorageService implements IStorageService {
  private readonly root: string;

  constructor(storagePath: string = config.storagePath) {
    this.root = storagePath;
  }

  private resolve(filePath: string): string {
    return path.join(this.root, filePath);
  }

  async store(filePath: string, data: Buffer | NodeJS.ReadableStream): Promise<void> {
    const absolute = this.resolve(filePath);
    const dir = path.dirname(absolute);

    try {
      await fsPromises.mkdir(dir, { recursive: true });

      if (Buffer.isBuffer(data)) {
        await fsPromises.writeFile(absolute, data);
      } else {
        const writeStream = fs.createWriteStream(absolute);
        await pipeline(data as Readable, writeStream);
      }
    } catch (err) {
      throw storageError(
        `Failed to store file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async retrieve(filePath: string): Promise<Buffer> {
    const absolute = this.resolve(filePath);
    try {
      return await fsPromises.readFile(absolute);
    } catch (err) {
      throw storageError(
        `Failed to retrieve file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  retrieveStream(filePath: string): NodeJS.ReadableStream {
    const absolute = this.resolve(filePath);
    return fs.createReadStream(absolute);
  }

  async delete(filePath: string): Promise<void> {
    const absolute = this.resolve(filePath);
    try {
      await fsPromises.unlink(absolute);
    } catch (err) {
      // If file doesn't exist, treat as success — idempotent delete
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw storageError(
        `Failed to delete file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const absolute = this.resolve(filePath);
    try {
      await fsPromises.access(absolute);
      return true;
    } catch {
      return false;
    }
  }
}

export const storageService = new StorageService();
