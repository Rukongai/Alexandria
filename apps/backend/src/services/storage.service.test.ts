import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { StorageService } from './storage.service.js';
import { AppError } from '../utils/errors.js';

let tmpDir: string;
let service: StorageService;

beforeEach(async () => {
  // Each test gets a fresh temp directory — no shared state
  tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'alex-storage-test-'));
  service = new StorageService(tmpDir);
});

afterEach(async () => {
  // Clean up temp dir after each test
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

describe('StorageService.store', () => {
  it('should write a Buffer to the given path under the storage root', async () => {
    const content = Buffer.from('hello world');
    await service.store('models/abc/file.txt', content);

    const written = await fsPromises.readFile(path.join(tmpDir, 'models', 'abc', 'file.txt'));
    expect(written).toEqual(content);
  });

  it('should create intermediate directories when they do not exist', async () => {
    await service.store('deeply/nested/dirs/file.bin', Buffer.from('data'));

    const exists = fs.existsSync(path.join(tmpDir, 'deeply', 'nested', 'dirs', 'file.bin'));
    expect(exists).toBe(true);
  });

  it('should write a readable stream to the given path', async () => {
    const content = 'streamed content';
    const readable = Readable.from([content]);

    await service.store('models/abc/stream.txt', readable);

    const written = await fsPromises.readFile(path.join(tmpDir, 'models', 'abc', 'stream.txt'), 'utf8');
    expect(written).toBe(content);
  });

  it('should throw a StorageError when the write fails due to invalid path', async () => {
    // Use a path that starts with a null byte — guaranteed to fail on every OS
    await expect(service.store('\0invalid', Buffer.from('x'))).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
    });
  });
});

describe('StorageService.retrieve', () => {
  it('should return the file contents as a Buffer', async () => {
    const content = Buffer.from('retrieve me');
    await fsPromises.mkdir(path.join(tmpDir, 'models'), { recursive: true });
    await fsPromises.writeFile(path.join(tmpDir, 'models', 'test.txt'), content);

    const result = await service.retrieve('models/test.txt');
    expect(result).toEqual(content);
  });

  it('should throw a StorageError when the file does not exist', async () => {
    await expect(service.retrieve('nonexistent/file.txt')).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
    });
  });

  it('should throw an AppError instance when the file does not exist', async () => {
    await expect(service.retrieve('nonexistent.txt')).rejects.toBeInstanceOf(AppError);
  });
});

describe('StorageService.retrieveStream', () => {
  it('should return a readable stream for an existing file', async () => {
    const content = 'stream this';
    await fsPromises.writeFile(path.join(tmpDir, 'data.txt'), content);

    const stream = service.retrieveStream('data.txt');
    expect(stream).toBeDefined();
    expect(typeof stream.pipe).toBe('function');

    // Collect stream data to verify contents
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    expect(Buffer.concat(chunks).toString()).toBe(content);
  });
});

describe('StorageService.delete', () => {
  it('should remove a file that exists', async () => {
    const filePath = path.join(tmpDir, 'to-delete.txt');
    await fsPromises.writeFile(filePath, 'data');

    await service.delete('to-delete.txt');

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('should succeed without throwing when the file does not exist', async () => {
    // Idempotent delete — should not throw for ENOENT
    await expect(service.delete('does-not-exist.txt')).resolves.toBeUndefined();
  });

  it('should throw a StorageError for other deletion failures', async () => {
    // A path with a null byte causes an OS-level error that is not ENOENT
    await expect(service.delete('\0invalid')).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
    });
  });
});

describe('StorageService.exists', () => {
  it('should return true when the file exists', async () => {
    await fsPromises.writeFile(path.join(tmpDir, 'present.txt'), 'hi');

    const result = await service.exists('present.txt');
    expect(result).toBe(true);
  });

  it('should return false when the file does not exist', async () => {
    const result = await service.exists('absent.txt');
    expect(result).toBe(false);
  });

  it('should return false for a nested path that does not exist', async () => {
    const result = await service.exists('nested/path/absent.txt');
    expect(result).toBe(false);
  });
});
