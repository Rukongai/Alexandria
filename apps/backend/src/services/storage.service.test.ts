import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { sanitizePathSegment, StorageService } from './storage.service.js';
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

describe('sanitizePathSegment', () => {
  it('should strip forward slashes', () => {
    expect(sanitizePathSegment('foo/bar')).toBe('foo_bar');
  });

  it('should strip backslashes', () => {
    expect(sanitizePathSegment('foo\\bar')).toBe('foo_bar');
  });

  it('should strip null bytes', () => {
    expect(sanitizePathSegment('foo\x00bar')).toBe('foo_bar');
  });

  it('should strip Windows-illegal characters', () => {
    expect(sanitizePathSegment('foo<>:"|?*bar')).toBe('foo_bar');
  });

  it('should collapse consecutive underscores into one', () => {
    expect(sanitizePathSegment('foo___bar')).toBe('foo_bar');
  });

  it('should collapse underscores produced by stripping multiple consecutive illegal characters', () => {
    expect(sanitizePathSegment('foo/\\bar')).toBe('foo_bar');
  });

  it('should trim leading underscores', () => {
    expect(sanitizePathSegment('_foo')).toBe('foo');
  });

  it('should trim trailing underscores', () => {
    expect(sanitizePathSegment('foo_')).toBe('foo');
  });

  it('should trim both leading and trailing underscores', () => {
    expect(sanitizePathSegment('_foo_')).toBe('foo');
  });

  it('should return _unknown for empty input', () => {
    expect(sanitizePathSegment('')).toBe('_unknown');
  });

  it('should return _unknown when all characters are illegal', () => {
    expect(sanitizePathSegment('/\\\x00<>:"|?*')).toBe('_unknown');
  });

  it('should return _unknown when input collapses to only underscores', () => {
    expect(sanitizePathSegment('___')).toBe('_unknown');
  });

  it('should preserve safe characters unchanged', () => {
    expect(sanitizePathSegment('My Artist Name')).toBe('My Artist Name');
  });
});

describe('StorageService.resolveModelPath', () => {
  // Uses a fixed rootPath — no real filesystem access needed for these unit tests
  const rootPath = '/storage/root';
  let modelService: StorageService;

  beforeEach(() => {
    modelService = new StorageService(rootPath);
  });

  it('should resolve {library} token correctly', () => {
    const result = modelService.resolveModelPath(
      'My Library',
      'My Model',
      {},
      '{library}/{model}',
      rootPath,
    );
    expect(result).toBe(path.resolve(rootPath, 'My Library', 'My Model'));
  });

  it('should resolve {model} token correctly', () => {
    const result = modelService.resolveModelPath(
      'lib',
      'Cool Model v2',
      {},
      '{library}/{model}',
      rootPath,
    );
    expect(result).toBe(path.resolve(rootPath, 'lib', 'Cool Model v2'));
  });

  it('should resolve {metadata.<slug>} tokens with matching metadata values', () => {
    const result = modelService.resolveModelPath(
      'lib',
      'model',
      { artist: 'Van Gogh' },
      '{library}/{metadata.artist}/{model}',
      rootPath,
    );
    expect(result).toBe(path.resolve(rootPath, 'lib', 'Van Gogh', 'model'));
  });

  it('should sanitize metadata values when resolving {metadata.<slug>} tokens', () => {
    const result = modelService.resolveModelPath(
      'lib',
      'model',
      { artist: 'Evil/Artist' },
      '{library}/{metadata.artist}/{model}',
      rootPath,
    );
    expect(result).toBe(path.resolve(rootPath, 'lib', 'Evil_Artist', 'model'));
  });

  it('should use _unknown for missing metadata values', () => {
    const result = modelService.resolveModelPath(
      'lib',
      'model',
      {},
      '{library}/{metadata.artist}/{model}',
      rootPath,
    );
    expect(result).toBe(path.resolve(rootPath, 'lib', '_unknown', 'model'));
  });

  it('should use _unknown for empty string metadata values', () => {
    const result = modelService.resolveModelPath(
      'lib',
      'model',
      { artist: '' },
      '{library}/{metadata.artist}/{model}',
      rootPath,
    );
    expect(result).toBe(path.resolve(rootPath, 'lib', '_unknown', 'model'));
  });

  it('should correctly join rootPath with resolved template', () => {
    const result = modelService.resolveModelPath(
      'mylib',
      'mymodel',
      {},
      '{library}/{model}',
      rootPath,
    );
    expect(result.startsWith(path.resolve(rootPath))).toBe(true);
  });

  it('should resolve multiple metadata tokens in one template', () => {
    const result = modelService.resolveModelPath(
      'lib',
      'model',
      { artist: 'Rembrandt', category: 'painting' },
      '{library}/{metadata.artist}/{metadata.category}/{model}',
      rootPath,
    );
    expect(result).toBe(path.resolve(rootPath, 'lib', 'Rembrandt', 'painting', 'model'));
  });

  it('should throw AppError when resolved path escapes rootPath due to traversal in library name', () => {
    // sanitizePathSegment strips path separators, but double-dots without separators pass through.
    // A library name of '..' becomes '..' after sanitization (no illegal chars), allowing escape.
    expect(() =>
      modelService.resolveModelPath(
        '..',
        'model',
        {},
        '{library}/{model}',
        rootPath,
      ),
    ).toThrow(AppError);
  });

  it('should throw AppError with code STORAGE_ERROR on path traversal escape', () => {
    let thrown: unknown;
    try {
      modelService.resolveModelPath(
        '..',
        'model',
        {},
        '{library}/{model}',
        rootPath,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('STORAGE_ERROR');
  });
});
