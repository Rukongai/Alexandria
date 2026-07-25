import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadModelFiles } from './download.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('downloadModelFiles', () => {
  it('streams files while preserving model-relative paths beneath the chosen directory', async () => {
    const root = await temporaryDirectory('alexandria-mcp-download-');
    const retrieveStream = vi.fn(async () => Readable.from(Buffer.from('solid model')));

    const result = await downloadModelFiles({
      downloadDirectory: root,
      subdirectory: 'dragon/files',
      files: [{
        id: 'file-1',
        relativePath: 'parts/body.stl',
        storagePath: 'models/model-1/parts/body.stl',
        sizeBytes: 11,
      }],
      overwrite: false,
      storage: { retrieveStream },
    });

    const destination = path.join(root, 'dragon', 'files', 'parts', 'body.stl');
    const canonicalDestination = await fs.realpath(destination);
    expect(await fs.readFile(destination, 'utf8')).toBe('solid model');
    expect(result).toEqual([{
      fileId: 'file-1',
      relativePath: 'parts/body.stl',
      destinationPath: canonicalDestination,
      sizeBytes: 11,
    }]);
  });

  it('refuses overwrite by default before retrieving any bytes', async () => {
    const root = await temporaryDirectory('alexandria-mcp-overwrite-');
    await fs.mkdir(path.join(root, 'chosen'), { recursive: true });
    await fs.writeFile(path.join(root, 'chosen', 'model.stl'), 'existing');
    const retrieveStream = vi.fn(async () => Readable.from('replacement'));

    await expect(downloadModelFiles({
      downloadDirectory: root,
      subdirectory: 'chosen',
      files: [{
        id: 'file-1',
        relativePath: 'model.stl',
        storagePath: 'stored/model.stl',
        sizeBytes: 1,
      }],
      overwrite: false,
      storage: { retrieveStream },
    })).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(retrieveStream).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, 'chosen', 'model.stl'), 'utf8'))
      .toBe('existing');
  });

  it('preflights every destination before retrieving the first file', async () => {
    const root = await temporaryDirectory('alexandria-mcp-preflight-');
    await fs.mkdir(path.join(root, 'chosen'), { recursive: true });
    await fs.writeFile(path.join(root, 'chosen', 'existing.stl'), 'existing');
    const retrieveStream = vi.fn(async () => Readable.from('new data'));

    await expect(downloadModelFiles({
      downloadDirectory: root,
      subdirectory: 'chosen',
      files: [
        {
          id: 'file-1',
          relativePath: 'new.stl',
          storagePath: 'stored/new.stl',
          sizeBytes: 8,
        },
        {
          id: 'file-2',
          relativePath: 'existing.stl',
          storagePath: 'stored/existing.stl',
          sizeBytes: 8,
        },
      ],
      overwrite: false,
      storage: { retrieveStream },
    })).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(retrieveStream).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, 'chosen', 'new.stl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects duplicate portable destination paths before retrieving any bytes', async () => {
    const root = await temporaryDirectory('alexandria-mcp-duplicate-');
    const retrieveStream = vi.fn(async () => Readable.from('new data'));

    await expect(downloadModelFiles({
      downloadDirectory: root,
      subdirectory: 'chosen',
      files: [
        {
          id: 'file-1',
          relativePath: 'parts/Body.stl',
          storagePath: 'stored/one.stl',
          sizeBytes: 8,
        },
        {
          id: 'file-2',
          relativePath: 'parts/body.stl',
          storagePath: 'stored/two.stl',
          sizeBytes: 8,
        },
      ],
      overwrite: true,
      storage: { retrieveStream },
    })).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(retrieveStream).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(root, 'chosen', 'parts'))).toEqual([]);
  });

  it('rejects traversal in both chosen and stored relative paths', async () => {
    const root = await temporaryDirectory('alexandria-mcp-traversal-');
    const storage = { retrieveStream: vi.fn(async () => Readable.from('data')) };
    const file = {
      id: 'file-1',
      relativePath: 'model.stl',
      storagePath: 'stored/model.stl',
      sizeBytes: 1,
    };

    await expect(downloadModelFiles({
      downloadDirectory: root,
      subdirectory: '../outside',
      files: [file],
      overwrite: false,
      storage,
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(downloadModelFiles({
      downloadDirectory: root,
      subdirectory: 'chosen',
      files: [{ ...file, relativePath: 'parts/../../outside.stl' }],
      overwrite: false,
      storage,
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(storage.retrieveStream).not.toHaveBeenCalled();
  });

  it('blocks a pre-existing symlink beneath the configured directory', async () => {
    const root = await temporaryDirectory('alexandria-mcp-symlink-root-');
    const outside = await temporaryDirectory('alexandria-mcp-symlink-outside-');
    await fs.symlink(outside, path.join(root, 'escape'));

    await expect(downloadModelFiles({
      downloadDirectory: root,
      subdirectory: 'escape',
      files: [{
        id: 'file-1',
        relativePath: 'model.stl',
        storagePath: 'stored/model.stl',
        sizeBytes: 1,
      }],
      overwrite: false,
      storage: { retrieveStream: vi.fn(async () => Readable.from('data')) },
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('rejects a symlinked configured root without creating anything outside it', async () => {
    const parent = await temporaryDirectory('alexandria-mcp-root-link-parent-');
    const outside = await temporaryDirectory('alexandria-mcp-root-link-outside-');
    const configuredRoot = path.join(parent, 'downloads');
    await fs.symlink(outside, configuredRoot);

    await expect(downloadModelFiles({
      downloadDirectory: configuredRoot,
      subdirectory: 'created-by-download',
      files: [{
        id: 'file-1',
        relativePath: 'model.stl',
        storagePath: 'stored/model.stl',
        sizeBytes: 1,
      }],
      overwrite: false,
      storage: { retrieveStream: vi.fn(async () => Readable.from('data')) },
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('requires the configured root to exist before downloading', async () => {
    const parent = await temporaryDirectory('alexandria-mcp-missing-root-');
    const configuredRoot = path.join(parent, 'missing-downloads');

    await expect(downloadModelFiles({
      downloadDirectory: configuredRoot,
      subdirectory: 'chosen',
      files: [{
        id: 'file-1',
        relativePath: 'model.stl',
        storagePath: 'stored/model.stl',
        sizeBytes: 1,
      }],
      overwrite: false,
      storage: { retrieveStream: vi.fn(async () => Readable.from('data')) },
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(fs.access(configuredRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a download root writable by other local accounts',
    async () => {
      const root = await temporaryDirectory('alexandria-mcp-writable-root-');
      await fs.chmod(root, 0o770);

      await expect(downloadModelFiles({
        downloadDirectory: root,
        subdirectory: 'chosen',
        files: [{
          id: 'file-1',
          relativePath: 'model.stl',
          storagePath: 'stored/model.stl',
          sizeBytes: 1,
        }],
        overwrite: false,
        storage: { retrieveStream: vi.fn(async () => Readable.from('data')) },
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a root beneath a writable non-sticky ancestor',
    async () => {
      const parent = await temporaryDirectory('alexandria-mcp-writable-parent-');
      const root = path.join(parent, 'operator-root');
      await fs.mkdir(root, { mode: 0o700 });
      await fs.chmod(parent, 0o777);

      await expect(downloadModelFiles({
        downloadDirectory: root,
        subdirectory: 'chosen',
        files: [{
          id: 'file-1',
          relativePath: 'model.stl',
          storagePath: 'stored/model.stl',
          sizeBytes: 1,
        }],
        overwrite: false,
        storage: { retrieveStream: vi.fn(async () => Readable.from('data')) },
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    },
  );

  it.each([false, true])(
    'refuses a destination-file symlink when overwrite is %s',
    async (overwrite) => {
      const root = await temporaryDirectory('alexandria-mcp-file-symlink-root-');
      const outside = await temporaryDirectory('alexandria-mcp-file-symlink-outside-');
      const outsideFile = path.join(outside, 'outside.stl');
      await fs.writeFile(outsideFile, 'outside');
      await fs.mkdir(path.join(root, 'chosen'), { recursive: true });
      await fs.symlink(outsideFile, path.join(root, 'chosen', 'model.stl'));
      const retrieveStream = vi.fn(async () => Readable.from('replacement'));

      await expect(downloadModelFiles({
        downloadDirectory: root,
        subdirectory: 'chosen',
        files: [{
          id: 'file-1',
          relativePath: 'model.stl',
          storagePath: 'stored/model.stl',
          sizeBytes: 11,
        }],
        overwrite,
        storage: { retrieveStream },
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

      expect(retrieveStream).not.toHaveBeenCalled();
      expect(await fs.readFile(outsideFile, 'utf8')).toBe('outside');
    },
  );

  it('removes atomic temporary files and leaves no destination when streaming fails', async () => {
    const root = await temporaryDirectory('alexandria-mcp-stream-failure-');
    const failingStream = new Readable({
      read() {
        this.destroy(new Error('storage read failed'));
      },
    });

    await expect(downloadModelFiles({
      downloadDirectory: root,
      subdirectory: 'chosen',
      files: [{
        id: 'file-1',
        relativePath: 'model.stl',
        storagePath: 'stored/model.stl',
        sizeBytes: 11,
      }],
      overwrite: false,
      storage: { retrieveStream: vi.fn(async () => failingStream) },
    })).rejects.toThrow('storage read failed');

    expect(await fs.readdir(path.join(root, 'chosen'))).toEqual([]);
  });

  it.each([false, true])(
    'leaves no partial multi-file result when a later stream fails and overwrite is %s',
    async (overwrite) => {
      const root = await temporaryDirectory('alexandria-mcp-multi-failure-');
      const chosen = path.join(root, 'chosen');
      await fs.mkdir(chosen, { recursive: true });
      if (overwrite) {
        await fs.writeFile(path.join(chosen, 'first.stl'), 'original first');
        await fs.writeFile(path.join(chosen, 'second.stl'), 'original second');
      }
      const retrieveStream = vi.fn(async () => {
        if (retrieveStream.mock.calls.length === 1) return Readable.from('replacement first');
        return new Readable({
          read() {
            this.destroy(new Error('second storage read failed'));
          },
        });
      });

      await expect(downloadModelFiles({
        downloadDirectory: root,
        subdirectory: 'chosen',
        files: [
          {
            id: 'file-1',
            relativePath: 'first.stl',
            storagePath: 'stored/first.stl',
            sizeBytes: 1,
          },
          {
            id: 'file-2',
            relativePath: 'second.stl',
            storagePath: 'stored/second.stl',
            sizeBytes: 1,
          },
        ],
        overwrite,
        storage: { retrieveStream },
      })).rejects.toThrow('second storage read failed');

      if (overwrite) {
        expect(await fs.readFile(path.join(chosen, 'first.stl'), 'utf8')).toBe('original first');
        expect(await fs.readFile(path.join(chosen, 'second.stl'), 'utf8')).toBe('original second');
        expect((await fs.readdir(chosen)).sort()).toEqual(['first.stl', 'second.stl']);
      } else {
        expect(await fs.readdir(chosen)).toEqual([]);
      }
    },
  );
});
