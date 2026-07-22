import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import { storageError } from '../utils/errors.js';
import type {
  IStorageService,
  StorageData,
  StorageProgressCallback,
} from './storage.service.js';
import { normalizeStoragePrefix, validateStorageKey } from './storage-key.js';

export const S3_MULTIPART_PART_SIZE = 8 * 1024 * 1024;
export const S3_SINGLE_COPY_MAX_SIZE = 5 * 1024 * 1024 * 1024;

export interface S3StorageServiceOptions {
  client: S3Client;
  bucket: string;
  prefix?: string;
}

export class S3StorageService implements IStorageService {
  readonly kind = 's3' as const;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3StorageServiceOptions) {
    if (!options.bucket || options.bucket.includes('/') || options.bucket.includes('\\')) {
      throw storageError('S3 bucket must be a non-empty bucket name');
    }

    this.client = options.client;
    this.bucket = options.bucket;
    this.prefix = normalizeStoragePrefix(options.prefix);
  }

  async store(
    filePath: string,
    data: StorageData,
    onProgress?: StorageProgressCallback,
  ): Promise<void> {
    const key = this.objectKey(filePath);

    try {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: data,
        },
        partSize: S3_MULTIPART_PART_SIZE,
        leavePartsOnError: false,
      });
      upload.on('httpUploadProgress', ({ loaded }) => {
        if (loaded !== undefined) {
          reportStorageProgress(onProgress, loaded);
        }
      });
      await upload.done();
    } catch (error) {
      throw storageError(`Failed to store file at ${filePath}: ${errorMessage(error)}`);
    }
  }

  async retrieve(filePath: string): Promise<Buffer> {
    const stream = await this.retrieveStream(filePath);
    const chunks: Buffer[] = [];

    try {
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      throw storageError(`Failed to retrieve file at ${filePath}: ${errorMessage(error)}`);
    }
  }

  async retrieveStream(filePath: string): Promise<Readable> {
    const key = this.objectKey(filePath);

    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) {
        throw new Error('S3 returned an empty response body');
      }
      if (response.Body instanceof Readable) {
        return response.Body;
      }

      return Readable.from(response.Body as AsyncIterable<Uint8Array>);
    } catch (error) {
      throw storageError(`Failed to retrieve file at ${filePath}: ${errorMessage(error)}`);
    }
  }

  async copy(sourcePath: string, destinationPath: string): Promise<void> {
    const sourceKey = this.objectKey(sourcePath);
    const destinationKey = this.objectKey(destinationPath);

    try {
      const source = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: sourceKey }),
      );
      if (
        source.ContentLength === undefined ||
        source.ContentLength > S3_SINGLE_COPY_MAX_SIZE
      ) {
        await this.store(destinationPath, await this.retrieveStream(sourcePath));
        return;
      }

      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: destinationKey,
          CopySource: encodeURIComponent(`${this.bucket}/${sourceKey}`),
        }),
      );
    } catch (error) {
      throw storageError(
        `Failed to copy file from ${sourcePath} to ${destinationPath}: ${errorMessage(error)}`,
      );
    }
  }

  async delete(filePath: string): Promise<void> {
    const key = this.objectKey(filePath);

    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw storageError(`Failed to delete file at ${filePath}: ${errorMessage(error)}`);
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const key = this.objectKey(filePath);

    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw storageError(`Failed to check file at ${filePath}: ${errorMessage(error)}`);
    }
  }

  async validateBucketAccess(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      throw storageError(`Failed to access S3 bucket ${this.bucket}: ${errorMessage(error)}`);
    }
  }

  private objectKey(filePath: string): string {
    const key = validateStorageKey(filePath);
    return this.prefix ? `${this.prefix}/${key}` : key;
  }
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportStorageProgress(
  onProgress: StorageProgressCallback | undefined,
  transferredBytes: number,
): void {
  try {
    onProgress?.(transferredBytes);
  } catch {
    // Progress is observational and must never turn a successful upload into a failure.
  }
}
