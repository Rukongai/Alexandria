import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  UploadPartCopyCommand,
  type CompletedPart,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import { storageError } from '../utils/errors.js';
import { normalizeEtag } from '../utils/etag.js';
import type {
  IStorageService,
  StorageData,
  StorageDeleteFailure,
  StorageProgressCallback,
  StoreResult,
} from './storage.service.js';
import { normalizeStoragePrefix, validateStorageKey } from './storage-key.js';

export const S3_MULTIPART_PART_SIZE = 8 * 1024 * 1024;
export const S3_SINGLE_COPY_MAX_SIZE = 5 * 1024 * 1024 * 1024;
/**
 * Range size per UploadPartCopy when an object is too large for a single
 * CopyObject. Comfortably under S3's 5 GiB per-part ceiling, and at the 10,000
 * part limit it covers objects far larger than anything Alexandria stores.
 */
export const S3_COPY_PART_SIZE = 1024 * 1024 * 1024;
/**
 * Objects per DeleteObjects request.
 *
 * The protocol allows 1,000, but providers meter deletion work rather than
 * request count: MEGA S4's guidance is that ~100 per request balances delete
 * throughput against contention with uploads running alongside it, and that
 * 1,000-key batches degrade everything else. Batches are also sent one at a
 * time for the same reason.
 *
 * @see https://help.mega.io/megas4/setup-guides/mega-s4-rate-limits-and-performance-guidance
 */
export const S3_DELETE_BATCH_SIZE = 100;

export interface S3StorageServiceOptions {
  client: S3Client;
  bucket: string;
  prefix?: string;
}

export class S3StorageService implements IStorageService {
  readonly kind = 's3' as const;
  readonly uploadPartSize = S3_MULTIPART_PART_SIZE;

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
  ): Promise<StoreResult> {
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
      const result = await upload.done();
      return { etag: normalizeEtag(result.ETag), partSize: S3_MULTIPART_PART_SIZE };
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

      if (source.ContentLength === undefined) {
        // Without a length the object cannot be split into copy ranges, so fall
        // back to streaming it through this process.
        await this.store(destinationPath, await this.retrieveStream(sourcePath));
        return;
      }

      if (source.ContentLength > S3_SINGLE_COPY_MAX_SIZE) {
        // Server-side multipart copy keeps the bytes inside the provider
        // instead of pulling them down and pushing them straight back up.
        await this.copyViaMultipart(sourceKey, destinationKey, source.ContentLength);
        return;
      }

      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: destinationKey,
          CopySource: this.copySource(sourceKey),
        }),
      );
    } catch (error) {
      throw storageError(
        `Failed to copy file from ${sourcePath} to ${destinationPath}: ${errorMessage(error)}`,
      );
    }
  }

  private async copyViaMultipart(
    sourceKey: string,
    destinationKey: string,
    contentLength: number,
  ): Promise<void> {
    const created = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: destinationKey }),
    );
    const uploadId = created.UploadId;
    if (!uploadId) {
      throw new Error('S3 did not return an upload ID for the multipart copy');
    }

    try {
      const parts: CompletedPart[] = [];
      for (let offset = 0; offset < contentLength; offset += S3_COPY_PART_SIZE) {
        const end = Math.min(offset + S3_COPY_PART_SIZE, contentLength) - 1;
        const partNumber = parts.length + 1;

        const copied = await this.client.send(
          new UploadPartCopyCommand({
            Bucket: this.bucket,
            Key: destinationKey,
            UploadId: uploadId,
            PartNumber: partNumber,
            CopySource: this.copySource(sourceKey),
            CopySourceRange: `bytes=${offset}-${end}`,
          }),
        );
        parts.push({ ETag: copied.CopyPartResult?.ETag, PartNumber: partNumber });
      }

      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: destinationKey,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
    } catch (error) {
      // An abandoned multipart upload keeps billing for the ranges already
      // copied, so always attempt to clear it before surfacing the failure.
      await this.client
        .send(
          new AbortMultipartUploadCommand({
            Bucket: this.bucket,
            Key: destinationKey,
            UploadId: uploadId,
          }),
        )
        .catch(() => {});
      throw error;
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

  async deleteMany(filePaths: string[]): Promise<StorageDeleteFailure[]> {
    const failures: StorageDeleteFailure[] = [];
    const keyed: { filePath: string; key: string }[] = [];

    for (const filePath of filePaths) {
      try {
        keyed.push({ filePath, key: this.objectKey(filePath) });
      } catch (error) {
        // A key that cannot be built is this path's failure alone; the rest of
        // the batch is still deletable.
        failures.push({ filePath, reason: errorMessage(error) });
      }
    }

    for (let offset = 0; offset < keyed.length; offset += S3_DELETE_BATCH_SIZE) {
      const batch = keyed.slice(offset, offset + S3_DELETE_BATCH_SIZE);
      failures.push(...(await this.deleteBatch(batch)));
    }

    return failures;
  }

  private async deleteBatch(
    batch: { filePath: string; key: string }[],
  ): Promise<StorageDeleteFailure[]> {
    let response;
    try {
      response = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          // Quiet returns only the keys that failed. The successes are the
          // batch minus those, and S3 counts deleting an absent key as success,
          // which matches how the single-object path treats a missing object.
          Delete: { Objects: batch.map(({ key }) => ({ Key: key })), Quiet: true },
        }),
      );
    } catch (error) {
      // The request itself failed, so nothing in this batch was deleted.
      const reason = errorMessage(error);
      return batch.map(({ filePath }) => ({ filePath, reason }));
    }

    if (!response.Errors?.length) return [];

    // A DeleteObjects response is HTTP 200 even when individual keys fail, so
    // the per-key errors have to be read out of the body or failures are lost.
    const byKey = new Map(batch.map(({ filePath, key }) => [key, filePath]));
    return response.Errors.map((failure) => ({
      filePath: (failure.Key && byKey.get(failure.Key)) || failure.Key || 'unknown',
      reason: [failure.Code, failure.Message].filter(Boolean).join(': ') || 'unknown error',
    }));
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

  private copySource(sourceKey: string): string {
    return encodeURIComponent(`${this.bucket}/${sourceKey}`);
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

/**
 * Describe an S3 failure without discarding the code that identifies it.
 *
 * Providers signal throttling with a distinct code — `SlowDown` on MEGA S4 —
 * and the SDK carries it on `name` rather than in the message. Dropping it
 * makes a rate-limited deployment read exactly like a credentials fault, and
 * the provider's own guidance is to watch the logs for these responses.
 */
function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const { httpStatusCode } = (error as { $metadata?: { httpStatusCode?: number } })
    .$metadata ?? {};
  const parts = [error.message];
  if (error.name && error.name !== 'Error' && !error.message.includes(error.name)) {
    parts.push(error.name);
  }
  if (httpStatusCode !== undefined) parts.push(`HTTP ${httpStatusCode}`);

  return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : parts[0];
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
