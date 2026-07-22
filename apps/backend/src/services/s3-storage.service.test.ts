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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/index.js';
import { AppError } from '../utils/errors.js';
import {
  S3_MULTIPART_PART_SIZE,
  S3StorageService,
} from './s3-storage.service.js';
import { describeStorageServiceContract } from './storage-service.contract.js';
import { createStorageService } from './storage.service.js';

const uploadMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  done: vi.fn(),
}));

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: vi.fn(function (options: unknown) {
    uploadMocks.construct(options);
    return { done: () => uploadMocks.done(options) };
  }),
}));

interface UploadOptions {
  client: InMemoryS3Client;
  params: {
    Bucket: string;
    Key: string;
    Body: Buffer | NodeJS.ReadableStream;
  };
  partSize: number;
  leavePartsOnError: boolean;
}

async function toBuffer(value: Buffer | NodeJS.ReadableStream): Promise<Buffer> {
  if (Buffer.isBuffer(value)) return value;

  const chunks: Buffer[] = [];
  for await (const chunk of value) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

class InMemoryS3Client {
  readonly objects = new Map<string, Buffer>();
  readonly send = vi.fn(async (command: unknown) => {
    if (command instanceof GetObjectCommand) {
      const content = this.objects.get(command.input.Key!);
      if (!content) throw notFoundError();
      return { Body: Readable.from([content]) };
    }
    if (command instanceof HeadObjectCommand) {
      if (!this.objects.has(command.input.Key!)) throw notFoundError();
      return {};
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(command.input.Key!);
      return {};
    }
    if (command instanceof CopyObjectCommand) {
      const decodedSource = decodeURIComponent(command.input.CopySource!);
      const sourceKey = decodedSource.slice(decodedSource.indexOf('/') + 1);
      const content = this.objects.get(sourceKey);
      if (!content) throw notFoundError();
      this.objects.set(command.input.Key!, Buffer.from(content));
      return {};
    }
    if (command instanceof HeadBucketCommand) return {};

    throw new Error(`Unexpected S3 command: ${String(command)}`);
  });
}

function notFoundError(): Error {
  return Object.assign(new Error('object not found'), {
    name: 'NoSuchKey',
    $metadata: { httpStatusCode: 404 },
  });
}

function asS3Client(client: InMemoryS3Client): S3Client {
  return client as unknown as S3Client;
}

describeStorageServiceContract('S3StorageService', async () => {
  const client = new InMemoryS3Client();
  uploadMocks.done.mockImplementation(async (rawOptions: unknown) => {
    const options = rawOptions as UploadOptions;
    options.client.objects.set(options.params.Key, await toBuffer(options.params.Body));
    return {};
  });

  return {
    service: new S3StorageService({
      client: asS3Client(client),
      bucket: 'contract-bucket',
      prefix: 'alexandria/',
    }),
  };
});

describe('S3StorageService', () => {
  let client: InMemoryS3Client;
  let service: S3StorageService;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new InMemoryS3Client();
    service = new S3StorageService({
      client: asS3Client(client),
      bucket: 'model-library',
      prefix: 'alexandria/',
    });
    uploadMocks.done.mockResolvedValue({});
  });

  it('should normalize a trailing prefix separator and apply the prefix once', async () => {
    await service.store('models/example.stl', Buffer.from('solid model'));

    expect(Upload).toHaveBeenCalledTimes(1);
    expect(uploadMocks.construct).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          Bucket: 'model-library',
          Key: 'alexandria/models/example.stl',
        }),
      }),
    );
  });

  it('should configure managed uploads with S3-safe multipart settings', async () => {
    await service.store('models/large.stl', Readable.from([Buffer.from('content')]));

    expect(S3_MULTIPART_PART_SIZE).toBe(8 * 1024 * 1024);
    expect(uploadMocks.construct).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        partSize: S3_MULTIPART_PART_SIZE,
        leavePartsOnError: false,
      }),
    );
  });

  it('should use a native copy command with encoded and prefixed source and destination keys', async () => {
    client.objects.set('alexandria/models/source file.stl', Buffer.from('source'));

    await service.copy('models/source file.stl', 'models/copied file.stl');

    const command = client.send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(CopyObjectCommand);
    expect((command as CopyObjectCommand).input).toEqual({
      Bucket: 'model-library',
      Key: 'alexandria/models/copied file.stl',
      CopySource: encodeURIComponent('model-library/alexandria/models/source file.stl'),
    });
  });

  it('should send delete for an absent key without first checking existence', async () => {
    await expect(service.delete('models/absent.stl')).resolves.toBeUndefined();

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it('should return false only for not-found responses from object existence checks', async () => {
    await expect(service.exists('models/absent.stl')).resolves.toBe(false);

    client.send.mockRejectedValueOnce(new Error('endpoint unavailable'));
    await expect(service.exists('models/unavailable.stl')).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
    });
  });

  it('should map missing response bodies to an actionable storage error', async () => {
    client.send.mockResolvedValueOnce({});

    const result = service.retrieveStream('models/empty.stl');

    await expect(result).rejects.toBeInstanceOf(AppError);
    await expect(result).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
      message: expect.stringContaining('S3 returned an empty response body'),
    });
  });

  it('should map managed upload failures to storage errors', async () => {
    uploadMocks.done.mockRejectedValueOnce(new Error('multipart upload failed'));

    await expect(service.store('models/failure.stl', Buffer.from('content'))).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
      message: expect.stringContaining('multipart upload failed'),
    });
  });

  it('should validate bucket access with a head-bucket request', async () => {
    await service.validateBucketAccess();

    expect(client.send.mock.calls[0]?.[0]).toBeInstanceOf(HeadBucketCommand);
  });

  it('should create SDK clients with checksums limited to required requests and responses', async () => {
    const appConfig = {
      storageBackend: 's3',
      storagePath: '/unused',
      s3: {
        endpoint: 'http://127.0.0.1:9000',
        region: 'us-east-1',
        bucket: 'model-library',
        prefix: 'alexandria',
        forcePathStyle: true,
      },
    } as AppConfig;

    const created = createStorageService(appConfig) as S3StorageService;
    const sdkClient = (created as unknown as { client: S3Client }).client;

    await expect(sdkClient.config.requestChecksumCalculation()).resolves.toBe('WHEN_REQUIRED');
    await expect(sdkClient.config.responseChecksumValidation()).resolves.toBe('WHEN_REQUIRED');
  });
});
