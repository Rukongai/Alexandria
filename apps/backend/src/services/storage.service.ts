import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from '../config/index.js';
import { storageError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('StorageService');

export function sanitizePathSegment(value: string): string {
  // Strip path separators, null bytes, and other illegal filesystem characters
  // eslint-disable-next-line no-control-regex
  let sanitized = value.replace(/[/\\\x00<>:"|?*]/g, '_');
  // Collapse consecutive underscores
  sanitized = sanitized.replace(/_+/g, '_');
  // Trim leading/trailing underscores
  sanitized = sanitized.replace(/^_+|_+$/g, '');
  return sanitized || '_unknown';
}

export interface IStorageService {
  store(filePath: string, data: Buffer | NodeJS.ReadableStream): Promise<void>;
  retrieve(filePath: string): Promise<Buffer>;
  retrieveStream(filePath: string): NodeJS.ReadableStream;
  delete(filePath: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  getStorageRoot(): string;
  resolveStoragePath(filePath: string): string;
  resolveModelPath(
    libraryName: string,
    modelName: string,
    metadataValues: Record<string, string>,
    pathTemplate: string,
    rootPath: string,
  ): string;
}

export class StorageService implements IStorageService {
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

  resolveModelPath(
    libraryName: string,
    modelName: string,
    metadataValues: Record<string, string>,
    pathTemplate: string,
    rootPath: string,
  ): string {
    const resolvedTemplate = pathTemplate.replace(/\{([^}]+)\}/g, (match, token: string) => {
      if (token === 'library') {
        return sanitizePathSegment(libraryName);
      }
      if (token === 'model') {
        return sanitizePathSegment(modelName);
      }
      if (token.startsWith('metadata.')) {
        const slug = token.slice('metadata.'.length);
        const value = metadataValues[slug];
        if (value === undefined || value === null || value === '') {
          logger.warn(
            { service: 'StorageService', slug, libraryName, modelName },
            `Missing metadata value for token {${token}}, using fallback '_unknown'`,
          );
          return '_unknown';
        }
        return sanitizePathSegment(value);
      }
      // Unknown token — return as-is (sanitized)
      return sanitizePathSegment(match);
    });

    const resolvedAbsolute = path.resolve(rootPath, resolvedTemplate);
    const resolvedRoot = path.resolve(rootPath);

    if (!resolvedAbsolute.startsWith(resolvedRoot + path.sep) && resolvedAbsolute !== resolvedRoot) {
      throw storageError('Resolved path escapes storage root');
    }

    return resolvedAbsolute;
  }

  private resolve(filePath: string): string {
    const absolute = path.resolve(this.root, filePath);
    const root = path.resolve(this.root);
    if (!absolute.startsWith(root + path.sep) && absolute !== root) {
      throw storageError(`Path traversal attempt: ${filePath}`);
    }
    return absolute;
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
