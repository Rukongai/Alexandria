import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import archiver from 'archiver';
import * as tar from 'tar';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { path7z } from '7zip-bin-full';
import Seven from 'node-7z';
import {
  FileProcessingService,
  validateSplitArchiveSet,
  validateSplitZipSet,
  validate7zArchiveEntry,
  type FileManifest,
  type ManifestStorageProgress,
  type MultipartArchiveFile,
} from './file-processing.service.js';
import type { IStorageService } from './storage.service.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary zip file containing the given entries.
 * Returns the path to the written zip.
 */
function createTestZip(
  destPath: string,
  entries: Array<{ name: string; content: string }>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destPath);
    const archive = archiver('zip', { zlib: { level: 0 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);

    for (const entry of entries) {
      archive.append(entry.content, { name: entry.name });
    }

    archive.finalize();
  });
}

function decodeUuencodedFixture(encoded: string): { filename: string; data: Buffer } {
  const lines = encoded.replace(/\r\n/g, '\n').split('\n');
  const headerIndex = lines.findIndex((line) => /^begin [0-7]{3} .+$/.test(line));
  if (headerIndex === -1) throw new Error('Missing uuencode header');

  const filename = lines[headerIndex].replace(/^begin [0-7]{3} /, '');
  const decoded: number[] = [];
  let foundEnd = false;

  for (const line of lines.slice(headerIndex + 1)) {
    if (line === 'end') {
      foundEnd = true;
      break;
    }
    if (line.length === 0) continue;

    const byteCount = (line.charCodeAt(0) - 32) & 0x3f;
    if (byteCount === 0) continue;
    const lineBytes: number[] = [];
    for (let index = 1; index < line.length && lineBytes.length < byteCount; index += 4) {
      const a = (line.charCodeAt(index) - 32) & 0x3f;
      const b = (line.charCodeAt(index + 1) - 32) & 0x3f;
      const c = (line.charCodeAt(index + 2) - 32) & 0x3f;
      const d = (line.charCodeAt(index + 3) - 32) & 0x3f;
      lineBytes.push((a << 2) | (b >> 4));
      if (lineBytes.length < byteCount) lineBytes.push(((b & 0x0f) << 4) | (c >> 2));
      if (lineBytes.length < byteCount) lineBytes.push(((c & 0x03) << 6) | d);
    }
    if (lineBytes.length !== byteCount) throw new Error('Malformed uuencoded fixture line');
    decoded.push(...lineBytes);
  }

  if (!foundEnd) throw new Error('Missing uuencode end marker');
  return { filename, data: Buffer.from(decoded) };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let service: FileProcessingService;

beforeAll(async () => {
  tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'alex-fp-test-'));
  service = new FileProcessingService();
});

describe('FileProcessingService – managed-storage progress', () => {
  it('should aggregate provider-reported bytes across files in order', async () => {
    const extractDir = path.join(tmpDir, 'storage-progress');
    await fsPromises.mkdir(extractDir, { recursive: true });
    await fsPromises.writeFile(path.join(extractDir, 'first.stl'), 'first');
    await fsPromises.writeFile(path.join(extractDir, 'second.stl'), 'second!');

    const manifest: FileManifest = {
      entries: [
        {
          filename: 'first.stl',
          relativePath: 'first.stl',
          fileType: 'stl',
          mimeType: 'model/stl',
          sizeBytes: 5,
          hash: 'first-hash',
        },
        {
          filename: 'second.stl',
          relativePath: 'second.stl',
          fileType: 'stl',
          mimeType: 'model/stl',
          sizeBytes: 7,
          hash: 'second-hash',
        },
      ],
      totalSizeBytes: 12,
    };
    const store = vi.fn<IStorageService['store']>(async (key, _data, onProgress) => {
      if (key.endsWith('first.stl')) {
        onProgress?.(2);
        onProgress?.(5);
        onProgress?.(50);
      } else {
        onProgress?.(3);
        onProgress?.(7);
      }
      return {};
    });
    const storage = {
      kind: 's3',
      store,
    } as unknown as IStorageService;
    const progress = vi.fn();

    await service.copyManifestToStorage(extractDir, 'model-1', manifest, storage, progress);

    const events = progress.mock.calls.map(([event]) => event);

    // Files upload concurrently, so the interleaving of events is not fixed.
    // What must hold is that the counters only ever move forward, never exceed
    // the manifest totals, and land exactly on them.
    expect(events.length).toBeGreaterThan(0);
    for (const [index, event] of events.entries()) {
      expect(event.totalFiles).toBe(2);
      expect(event.totalBytes).toBe(12);
      expect(event.completedBytes).toBeLessThanOrEqual(12);
      expect(event.completedFiles).toBeLessThanOrEqual(2);

      if (index > 0) {
        expect(event.completedBytes).toBeGreaterThanOrEqual(events[index - 1].completedBytes);
        expect(event.completedFiles).toBeGreaterThanOrEqual(events[index - 1].completedFiles);
      }
    }

    // The first file's provider over-reports 50 bytes for a 5-byte file; that
    // must be clamped rather than inflating the aggregate.
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ completedFiles: 2, completedBytes: 12, totalBytes: 12 }),
    );
  });

  it('should upload manifest entries concurrently on a remote backend', async () => {
    const extractDir = path.join(tmpDir, 'storage-progress-concurrent');
    await fsPromises.mkdir(extractDir, { recursive: true });

    const entries = await Promise.all(
      Array.from({ length: 6 }, async (_unused, index) => {
        const filename = `part-${index}.stl`;
        await fsPromises.writeFile(path.join(extractDir, filename), 'data');
        return {
          filename,
          relativePath: filename,
          fileType: 'stl' as const,
          mimeType: 'model/stl',
          sizeBytes: 4,
          hash: `hash-${index}`,
        };
      }),
    );
    const manifest: FileManifest = { entries, totalSizeBytes: entries.length * 4 };

    let inFlight = 0;
    let peakInFlight = 0;
    const release: Array<() => void> = [];
    const storage = {
      kind: 's3',
      store: vi.fn<IStorageService['store']>(async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        // Hold every upload open until they have all started, so the peak
        // reflects real overlap rather than scheduling luck.
        await new Promise<void>((resolve) => {
          release.push(resolve);
          if (release.length === entries.length) release.forEach((fn) => fn());
        });
        inFlight -= 1;
        return {};
      }),
    } as unknown as IStorageService;

    await service.copyManifestToStorage(extractDir, 'model-1', manifest, storage);

    expect(peakInFlight).toBeGreaterThan(1);
  });

  it('should upload sequentially on a local backend', async () => {
    const extractDir = path.join(tmpDir, 'storage-progress-local');
    await fsPromises.mkdir(extractDir, { recursive: true });

    const entries = await Promise.all(
      Array.from({ length: 4 }, async (_unused, index) => {
        const filename = `part-${index}.stl`;
        await fsPromises.writeFile(path.join(extractDir, filename), 'data');
        return {
          filename,
          relativePath: filename,
          fileType: 'stl' as const,
          mimeType: 'model/stl',
          sizeBytes: 4,
          hash: `hash-${index}`,
        };
      }),
    );
    const manifest: FileManifest = { entries, totalSizeBytes: entries.length * 4 };

    let inFlight = 0;
    let peakInFlight = 0;
    const storage = {
      kind: 'local',
      store: vi.fn<IStorageService['store']>(async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return {};
      }),
    } as unknown as IStorageService;

    await service.copyManifestToStorage(extractDir, 'model-1', manifest, storage);

    // Filesystem writes gain nothing from fan-out, so ordering is preserved.
    expect(peakInFlight).toBe(1);
  });

  it('should coalesce high-frequency provider callbacks and flush exact final counters', async () => {
    const extractDir = path.join(tmpDir, 'storage-progress-burst');
    await fsPromises.mkdir(extractDir, { recursive: true });
    await fsPromises.writeFile(path.join(extractDir, 'large.stl'), 'placeholder');
    const totalBytes = 12 * 1024 * 1024;
    const manifest: FileManifest = {
      entries: [{
        filename: 'large.stl',
        relativePath: 'large.stl',
        fileType: 'stl',
        mimeType: 'model/stl',
        sizeBytes: totalBytes,
        hash: 'hash',
      }],
      totalSizeBytes: totalBytes,
    };
    const storage = {
      kind: 'local',
      store: vi.fn<IStorageService['store']>(async (_key, _data, onProgress) => {
        for (let transferred = 4096; transferred <= totalBytes; transferred += 4096) {
          onProgress?.(transferred);
        }
        return {};
      }),
    } as unknown as IStorageService;
    const observed: ManifestStorageProgress[] = [];
    const observer = vi.fn(async (progress) => {
      observed.push(progress);
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    await service.copyManifestToStorage(extractDir, 'model-1', manifest, storage, observer);

    expect(observer.mock.calls.length).toBeLessThanOrEqual(4);
    expect(observed.at(-1)).toEqual({
      completedFiles: 1,
      totalFiles: 1,
      completedBytes: totalBytes,
      totalBytes,
      currentFilename: 'large.stl',
    });
  });

  it('should not fail stored files when the progress observer rejects', async () => {
    const extractDir = path.join(tmpDir, 'storage-progress-error');
    await fsPromises.mkdir(extractDir, { recursive: true });
    await fsPromises.writeFile(path.join(extractDir, 'model.stl'), 'model');
    const manifest: FileManifest = {
      entries: [{
        filename: 'model.stl',
        relativePath: 'model.stl',
        fileType: 'stl',
        mimeType: 'model/stl',
        sizeBytes: 5,
        hash: 'hash',
      }],
      totalSizeBytes: 5,
    };
    const storage = {
      kind: 'local',
      store: vi.fn<IStorageService['store']>(async (_key, _data, onProgress) => {
        onProgress?.(5);
        return {};
      }),
    } as unknown as IStorageService;

    await expect(
      service.copyManifestToStorage(extractDir, 'model-1', manifest, storage, async () => {
        throw new Error('progress unavailable');
      }),
    ).resolves.toBeUndefined();
  });
});

afterAll(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// classifyExtension (tested indirectly via scanDirectory after extraction)
// We expose classification via a small helper zip so we can inspect manifest
// entries without needing to call the private method directly.
// ---------------------------------------------------------------------------

describe('FileProcessingService – file type classification', () => {
  it('should classify .stl files as stl', async () => {
    const zipPath = path.join(tmpDir, 'stl.zip');
    const extractDir = path.join(tmpDir, 'stl-extract');

    await createTestZip(zipPath, [{ name: 'model.stl', content: 'solid test\nendsolid test\n' }]);

    const manifest = await service.processArchive(zipPath, extractDir);

    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].fileType).toBe('stl');
    expect(manifest.entries[0].mimeType).toBe('model/stl');
  });

  it('should classify .jpg files as image', async () => {
    const zipPath = path.join(tmpDir, 'jpg.zip');
    const extractDir = path.join(tmpDir, 'jpg-extract');

    await createTestZip(zipPath, [{ name: 'photo.jpg', content: 'fake-jpg-data' }]);

    const manifest = await service.processArchive(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('image');
    expect(manifest.entries[0].mimeType).toBe('image/jpeg');
  });

  it('should classify .jpeg files as image', async () => {
    const zipPath = path.join(tmpDir, 'jpeg.zip');
    const extractDir = path.join(tmpDir, 'jpeg-extract');

    await createTestZip(zipPath, [{ name: 'photo.jpeg', content: 'fake-jpeg-data' }]);

    const manifest = await service.processArchive(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('image');
  });

  it('should classify .png files as image', async () => {
    const zipPath = path.join(tmpDir, 'png.zip');
    const extractDir = path.join(tmpDir, 'png-extract');

    await createTestZip(zipPath, [{ name: 'photo.png', content: 'fake-png-data' }]);

    const manifest = await service.processArchive(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('image');
    expect(manifest.entries[0].mimeType).toBe('image/png');
  });

  it('should classify .webp files as image', async () => {
    const zipPath = path.join(tmpDir, 'webp.zip');
    const extractDir = path.join(tmpDir, 'webp-extract');

    await createTestZip(zipPath, [{ name: 'photo.webp', content: 'fake-webp-data' }]);

    const manifest = await service.processArchive(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('image');
    expect(manifest.entries[0].mimeType).toBe('image/webp');
  });

  it('should classify .tif files as image', async () => {
    const zipPath = path.join(tmpDir, 'tif.zip');
    const extractDir = path.join(tmpDir, 'tif-extract');

    await createTestZip(zipPath, [{ name: 'scan.tif', content: 'fake-tif-data' }]);

    const manifest = await service.processArchive(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('image');
    expect(manifest.entries[0].mimeType).toBe('image/tiff');
  });

  it('should classify .tiff files as image', async () => {
    const zipPath = path.join(tmpDir, 'tiff.zip');
    const extractDir = path.join(tmpDir, 'tiff-extract');

    await createTestZip(zipPath, [{ name: 'scan.tiff', content: 'fake-tiff-data' }]);

    const manifest = await service.processArchive(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('image');
    expect(manifest.entries[0].mimeType).toBe('image/tiff');
  });

  it('should classify .pdf files as document', async () => {
    const zipPath = path.join(tmpDir, 'pdf.zip');
    const extractDir = path.join(tmpDir, 'pdf-extract');

    await createTestZip(zipPath, [{ name: 'readme.pdf', content: '%PDF-1.4 fake' }]);

    const manifest = await service.processArchive(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('document');
    expect(manifest.entries[0].mimeType).toBe('application/pdf');
  });

  it('should classify .txt files as document', async () => {
    const zipPath = path.join(tmpDir, 'txt.zip');
    const extractDir = path.join(tmpDir, 'txt-extract');

    await createTestZip(zipPath, [{ name: 'notes.txt', content: 'some notes' }]);

    const manifest = await service.processArchive(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('document');
    expect(manifest.entries[0].mimeType).toBe('text/plain');
  });

  it('should classify .md files as document', async () => {
    const zipPath = path.join(tmpDir, 'md.zip');
    const extractDir = path.join(tmpDir, 'md-extract');

    await createTestZip(zipPath, [{ name: 'README.md', content: '# Hello' }]);

    const manifest = await service.processArchive(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('document');
    expect(manifest.entries[0].mimeType).toBe('text/markdown');
  });

  it('should classify unknown extensions as other', async () => {
    const zipPath = path.join(tmpDir, 'other.zip');
    const extractDir = path.join(tmpDir, 'other-extract');

    await createTestZip(zipPath, [{ name: 'data.bin', content: 'binary data' }]);

    const manifest = await service.processArchive(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('other');
    expect(manifest.entries[0].mimeType).toBe('application/octet-stream');
  });
});

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

describe('FileProcessingService – hash computation', () => {
  it('should compute SHA-256 hash for files', async () => {
    const content = 'hello world';
    const zipPath = path.join(tmpDir, 'hash.zip');
    const extractDir = path.join(tmpDir, 'hash-extract');

    await createTestZip(zipPath, [{ name: 'hello.txt', content }]);

    const manifest = await service.processArchive(zipPath, extractDir);

    const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
    expect(manifest.entries[0].hash).toBe(expectedHash);
  });
});

// ---------------------------------------------------------------------------
// File filtering – hidden files and __MACOSX directories
// ---------------------------------------------------------------------------

describe('FileProcessingService – file filtering', () => {
  it('should skip hidden files starting with dot', async () => {
    const zipPath = path.join(tmpDir, 'hidden.zip');
    const extractDir = path.join(tmpDir, 'hidden-extract');

    await createTestZip(zipPath, [
      { name: 'visible.stl', content: 'solid\nendsolid\n' },
      { name: '.DS_Store', content: 'hidden' },
    ]);

    const manifest = await service.processArchive(zipPath, extractDir);

    const names = manifest.entries.map((e) => e.filename);
    expect(names).toContain('visible.stl');
    expect(names).not.toContain('.DS_Store');
    expect(manifest.entries).toHaveLength(1);
  });

  it('should skip __MACOSX directories', async () => {
    const zipPath = path.join(tmpDir, 'macos.zip');
    const extractDir = path.join(tmpDir, 'macos-extract');

    await createTestZip(zipPath, [
      { name: 'model.stl', content: 'solid\nendsolid\n' },
      { name: '__MACOSX/._model.stl', content: 'mac metadata' },
    ]);

    const manifest = await service.processArchive(zipPath, extractDir);

    const names = manifest.entries.map((e) => e.filename);
    expect(names).toContain('model.stl');
    expect(names).not.toContain('._model.stl');
    expect(manifest.entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Full manifest correctness
// ---------------------------------------------------------------------------

describe('FileProcessingService – processArchive (zip) manifest', () => {
  it('should extract zip and produce correct manifest with multiple file types', async () => {
    const stlContent = 'solid cube\nendsolid cube\n';
    const imageContent = 'fake-png-bytes';
    const docContent = '# Assembly Instructions';

    const zipPath = path.join(tmpDir, 'full.zip');
    const extractDir = path.join(tmpDir, 'full-extract');

    await createTestZip(zipPath, [
      { name: 'model.stl', content: stlContent },
      { name: 'preview.png', content: imageContent },
      { name: 'README.md', content: docContent },
      { name: '.hidden_file', content: 'skip me' },
      { name: '__MACOSX/._model.stl', content: 'skip me too' },
    ]);

    const manifest = await service.processArchive(zipPath, extractDir);

    // Only the three non-hidden, non-MACOSX files should appear
    expect(manifest.entries).toHaveLength(3);

    const stlEntry = manifest.entries.find((e) => e.filename === 'model.stl');
    const imageEntry = manifest.entries.find((e) => e.filename === 'preview.png');
    const docEntry = manifest.entries.find((e) => e.filename === 'README.md');

    expect(stlEntry).toBeDefined();
    expect(stlEntry!.fileType).toBe('stl');
    expect(stlEntry!.relativePath).toBe('model.stl');

    expect(imageEntry).toBeDefined();
    expect(imageEntry!.fileType).toBe('image');

    expect(docEntry).toBeDefined();
    expect(docEntry!.fileType).toBe('document');

    // totalSizeBytes should be the sum of individual file sizes
    const expectedTotal = manifest.entries.reduce((sum, e) => sum + e.sizeBytes, 0);
    expect(manifest.totalSizeBytes).toBe(expectedTotal);

    // Each entry must have a non-empty SHA-256 hash (64 hex chars)
    for (const entry of manifest.entries) {
      expect(entry.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.sizeBytes).toBeGreaterThan(0);
    }
  });
});

describe('validateSplitZipSet', () => {
  const files = (...filenames: string[]): MultipartArchiveFile[] => filenames.map(
    (originalFilename, index) => ({ tempFilePath: `/tmp/part-${index}`, originalFilename }),
  );

  it('accepts a complete classic set and selects the terminal zip', () => {
    expect(validateSplitZipSet(files('dragon.z02', 'dragon.zip', 'dragon.z01'))).toEqual({
      kind: 'classic',
      entryFilename: 'dragon.zip',
      logicalFilename: 'dragon.zip',
    });
  });

  it('accepts a contiguous numbered set beginning at 001', () => {
    expect(validateSplitZipSet(files('dragon.zip.002', 'dragon.zip.001'))).toEqual({
      kind: 'numbered',
      entryFilename: 'dragon.zip.001',
      logicalFilename: 'dragon.zip',
    });
  });

  it.each([
    [
      'classic extensions and base names',
      ['Dragon.Z01', 'DRAGON.z02', 'dragon.ZIP'],
      { kind: 'classic', entryFilename: 'dragon.zip', logicalFilename: 'dragon.ZIP' },
    ],
    [
      'numbered extensions and base names',
      ['Dragon.ZIP.002', 'dragon.zip.001'],
      { kind: 'numbered', entryFilename: 'dragon.zip.001', logicalFilename: 'dragon.zip' },
    ],
  ])('accepts %s case-insensitively', (_label, filenames, expected) => {
    expect(validateSplitZipSet(files(...filenames))).toEqual(expected);
  });

  it.each([
    ['a gap', ['dragon.z01', 'dragon.z03', 'dragon.zip']],
    ['a numbered gap', ['dragon.zip.001', 'dragon.zip.003']],
    ['mixed naming schemes', ['dragon.z01', 'dragon.zip', 'dragon.zip.001']],
    ['unrelated bases', ['dragon.z01', 'other.zip']],
    ['duplicate members', ['dragon.zip.001', 'DRAGON.ZIP.001']],
    ['duplicate classic part numbers', ['dragon.z01', 'DRAGON.Z01', 'dragon.zip']],
    ['a missing terminal zip', ['dragon.z01', 'dragon.z02']],
    ['an unrelated member', ['dragon.z01', 'dragon.zip', 'notes.txt']],
    ['classic part zero', ['dragon.z00', 'dragon.zip']],
    ['classic part above 99', ['dragon.z100', 'dragon.zip']],
    ['numbered part zero', ['dragon.zip.000', 'dragon.zip.001']],
    ['numbered part above 999', ['dragon.zip.001', 'dragon.zip.1000']],
  ])('rejects %s', (_label, filenames) => {
    expect(() => validateSplitZipSet(files(...filenames))).toThrow();
  });
});

describe('validateSplitArchiveSet – multi-volume RAR', () => {
  const files = (...filenames: string[]): MultipartArchiveFile[] => filenames.map(
    (originalFilename, index) => ({ tempFilePath: `/tmp/upload-${index}`, originalFilename }),
  );

  it('accepts a contiguous modern RAR set and derives its name from part 1', () => {
    expect(validateSplitArchiveSet(files(
      'NYMPHA3D - 2026-02.part2.RAR',
      'Nympha3D - 2026-02.part1.rar',
    ))).toEqual({
      kind: 'rar',
      entryFilename: 'nympha3d - 2026-02.part1.rar',
      logicalFilename: 'Nympha3D - 2026-02.rar',
    });
  });

  it('accepts consistent zero-padded part numbers', () => {
    expect(validateSplitArchiveSet(files(
      'bundle.part003.rar',
      'bundle.part001.rar',
      'bundle.part002.rar',
    ))).toEqual({
      kind: 'rar',
      entryFilename: 'bundle.part001.rar',
      logicalFilename: 'bundle.rar',
    });
  });

  it('accepts unpadded part numbers across a digit-width boundary', () => {
    const filenames = Array.from({ length: 10 }, (_, index) => `bundle.part${index + 1}.rar`);
    expect(validateSplitArchiveSet(files(...filenames.reverse()))).toMatchObject({
      kind: 'rar',
      entryFilename: 'bundle.part1.rar',
      logicalFilename: 'bundle.rar',
    });
  });

  it('accepts two-digit padding across part09 to part10', () => {
    const filenames = Array.from(
      { length: 10 },
      (_, index) => `bundle.part${String(index + 1).padStart(2, '0')}.rar`,
    );
    expect(validateSplitArchiveSet(files(...filenames.reverse()))).toMatchObject({
      kind: 'rar',
      entryFilename: 'bundle.part01.rar',
      logicalFilename: 'bundle.rar',
    });
  });

  it.each([
    ['a missing part 1', ['bundle.part2.rar', 'bundle.part3.rar']],
    ['a numbering gap', ['bundle.part1.rar', 'bundle.part3.rar']],
    ['unrelated bases', ['bundle.part1.rar', 'other.part2.rar']],
    ['duplicate part numbers', ['bundle.part1.rar', 'bundle.part01.rar']],
    ['inconsistent zero padding', ['bundle.part01.rar', 'bundle.part2.rar']],
    ['mixed ZIP and RAR members', ['bundle.part1.rar', 'bundle.zip.001']],
    ['part zero', ['bundle.part0.rar', 'bundle.part1.rar']],
  ])('rejects %s', (_label, filenames) => {
    expect(() => validateSplitArchiveSet(files(...filenames))).toThrow();
  });
});

describe('FileProcessingService – multipart archives', () => {
  it('selects the canonical name from selection order for combine and part order for split', () => {
    expect(service.validateMultipartArchives([
      { tempFilePath: '/tmp/second.zip', originalFilename: 'second-selected.zip' },
      { tempFilePath: '/tmp/first.zip', originalFilename: 'first-selected.zip' },
    ], 'combine')).toBe('second-selected.zip');

    expect(service.validateMultipartArchives([
      { tempFilePath: '/tmp/part-2', originalFilename: 'PACK.ZIP.002' },
      { tempFilePath: '/tmp/part-1', originalFilename: 'Pack.Zip.001' },
    ], 'split')).toBe('Pack.Zip');

    expect(service.validateMultipartArchives([
      { tempFilePath: '/tmp/part-2', originalFilename: 'PACK.Z02' },
      { tempFilePath: '/tmp/terminal', originalFilename: 'Pack.Zip' },
      { tempFilePath: '/tmp/part-1', originalFilename: 'pack.z01' },
    ], 'split')).toBe('Pack.Zip');
  });

  it.each([
    '...zip',
    '..zip',
    '.zip',
    'folder/model.zip',
    '/absolute/model.zip',
    'C:\\absolute\\model.zip',
  ])('rejects unsafe combine folder source %s', async (originalFilename) => {
    const processArchive = vi.spyOn(service, 'processArchive');
    await expect(service.processMultipartArchives(
      [
        { tempFilePath: '/tmp/a.zip', originalFilename },
        { tempFilePath: '/tmp/b.zip', originalFilename: 'safe.zip' },
      ],
      path.join(tmpDir, 'unsafe-combine'),
      'combine',
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(processArchive).not.toHaveBeenCalled();
    processArchive.mockRestore();
  });
  it('rejects split-only members in combine mode before extracting an archive', async () => {
    const processArchive = vi.spyOn(service, 'processArchive');

    await expect(service.processMultipartArchives(
      [
        { tempFilePath: '/tmp/model.z01', originalFilename: 'model.z01' },
        { tempFilePath: '/tmp/model.z02', originalFilename: 'model.z02' },
      ],
      path.join(tmpDir, 'invalid-combine-output'),
      'combine',
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(processArchive).not.toHaveBeenCalled();
  });

  it('directs multi-volume RAR members to split mode before extraction', async () => {
    const processArchive = vi.spyOn(service, 'processArchive');

    await expect(service.processMultipartArchives(
      [
        {
          tempFilePath: '/tmp/upload_first_Nympha3D.part1.rar',
          originalFilename: 'Nympha3D.part1.rar',
        },
        {
          tempFilePath: '/tmp/upload_second_Nympha3D.part2.rar',
          originalFilename: 'Nympha3D.part2.rar',
        },
      ],
      path.join(tmpDir, 'invalid-combine-rar-output'),
      'combine',
    )).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('Split archive mode'),
    });

    expect(processArchive).not.toHaveBeenCalled();
  });

  it('continues to accept independent complete RAR archives in combine mode', () => {
    expect(service.validateMultipartArchives([
      { tempFilePath: '/tmp/first.rar', originalFilename: 'first.rar' },
      { tempFilePath: '/tmp/second.rar', originalFilename: 'second.rar' },
    ], 'combine')).toBe('first.rar');
  });

  it('extracts colliding archive names into distinct archive-named folders', async () => {
    const firstDir = path.join(tmpDir, 'combine-first');
    const secondDir = path.join(tmpDir, 'combine-second');
    await fsPromises.mkdir(firstDir, { recursive: true });
    await fsPromises.mkdir(secondDir, { recursive: true });
    const firstZip = path.join(firstDir, 'model.zip');
    const secondZip = path.join(secondDir, 'model.zip');
    await createTestZip(firstZip, [{ name: 'first.stl', content: 'first' }]);
    await createTestZip(secondZip, [{ name: 'second.stl', content: 'second' }]);

    const manifest = await service.processMultipartArchives(
      [
        { tempFilePath: firstZip, originalFilename: 'Model.zip' },
        { tempFilePath: secondZip, originalFilename: 'model.ZIP' },
      ],
      path.join(tmpDir, 'combine-output'),
      'combine',
    );

    expect(manifest.entries.map((entry) => entry.relativePath).sort()).toEqual([
      path.join('Model', 'first.stl'),
      path.join('model-2', 'second.stl'),
    ].sort());
    expect(manifest.totalSizeBytes).toBe(11);
  });

  it('dispatches a classic split set to bundled 7-Zip using the terminal zip', async () => {
    const partOne = path.join(tmpDir, 'split-source-z01');
    const terminal = path.join(tmpDir, 'split-source-zip');
    await fsPromises.writeFile(partOne, 'part one');
    await fsPromises.writeFile(terminal, 'terminal');
    const expectedManifest = { entries: [], totalSizeBytes: 0 };
    const process7z = vi
      .spyOn(service as unknown as {
        process7z: (archivePath: string, extractDir: string) => Promise<typeof expectedManifest>;
      }, 'process7z')
      .mockResolvedValue(expectedManifest);
    const extractDir = path.join(tmpDir, 'split-output');

    await expect(service.processMultipartArchives(
      [
        { tempFilePath: partOne, originalFilename: 'bundle.z01' },
        { tempFilePath: terminal, originalFilename: 'bundle.zip' },
      ],
      extractDir,
      'split',
    )).resolves.toEqual(expectedManifest);

    expect(process7z).toHaveBeenCalledWith(
      expect.stringMatching(/bundle\.zip$/),
      extractDir,
    );
    process7z.mockRestore();
  });

  it('should colocate differently prefixed RAR volumes and extract them with 7-Zip from part 1', async () => {
    const firstSource = path.join(
      tmpDir,
      'upload_11111111-1111-4111-8111-111111111111_Nympha3D - 2026-02.part1.rar',
    );
    const secondSource = path.join(
      tmpDir,
      'upload_22222222-2222-4222-8222-222222222222_Nympha3D - 2026-02.part2.rar',
    );
    await fsPromises.writeFile(firstSource, 'part one');
    await fsPromises.writeFile(secondSource, 'part two');
    const expectedManifest = { entries: [], totalSizeBytes: 0 };
    const process7z = vi
      .spyOn(service as unknown as {
        process7z: (archivePath: string, extractDir: string) => Promise<FileManifest>;
      }, 'process7z')
      .mockImplementation(async (archivePath, extractDir) => {
        expect(path.basename(archivePath)).toBe('nympha3d - 2026-02.part1.rar');
        expect(extractDir).toBe(path.join(tmpDir, 'split-rar-output'));
        const partsDir = path.dirname(archivePath);
        await expect(fsPromises.access(
          path.join(partsDir, 'nympha3d - 2026-02.part1.rar'),
        )).resolves.toBeUndefined();
        await expect(fsPromises.access(
          path.join(partsDir, 'nympha3d - 2026-02.part2.rar'),
        )).resolves.toBeUndefined();
        return expectedManifest;
      });

    await expect(service.processMultipartArchives(
      [
        { tempFilePath: secondSource, originalFilename: 'Nympha3D - 2026-02.part2.rar' },
        { tempFilePath: firstSource, originalFilename: 'Nympha3D - 2026-02.part1.rar' },
      ],
      path.join(tmpDir, 'split-rar-output'),
      'split',
    )).resolves.toEqual(expectedManifest);

    expect(process7z).toHaveBeenCalledOnce();
    process7z.mockRestore();
  });

  it('should extract a real three-volume RAR fixture from part 1', async () => {
    const fixtureRoot = new URL('./fixtures/', import.meta.url);
    const sourceDir = path.join(tmpDir, 'real-rar-multivolume-source');
    const extractDir = path.join(tmpDir, 'real-rar-multivolume-output');
    await fsPromises.mkdir(sourceDir, { recursive: true });

    const files: MultipartArchiveFile[] = [];
    for (const part of [3, 1, 2]) {
      const fixtureName = `test_rar_multivolume_single_file.part${part}.rar.uu`;
      const encoded = await fsPromises.readFile(new URL(fixtureName, fixtureRoot), 'utf8');
      const decoded = decodeUuencodedFixture(encoded);
      expect(decoded.filename).toBe(fixtureName.replace(/\.uu$/, ''));
      const tempFilePath = path.join(sourceDir, `upload-${part}-${decoded.filename}`);
      await fsPromises.writeFile(tempFilePath, decoded.data);
      files.push({
        tempFilePath,
        originalFilename: `LibarchiveAddingTest.part${part}.rar`,
      });
    }

    const manifest = await service.processMultipartArchives(files, extractDir, 'split');
    const outputPath = path.join(extractDir, 'LibarchiveAddingTest.html');
    const content = await fsPromises.readFile(outputPath);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const expectedHash = 'ee16390e87152d7dec632ae2b37566da6135966e46b5166e6f40a1c827fa61ad';

    expect(manifest.entries).toEqual([
      expect.objectContaining({
        filename: 'LibarchiveAddingTest.html',
        relativePath: 'LibarchiveAddingTest.html',
        sizeBytes: 20_111,
        hash: expectedHash,
      }),
    ]);
    expect(manifest.totalSizeBytes).toBe(20_111);
    expect(content).toHaveLength(20_111);
    expect(hash).toBe(expectedHash);
    expect(content.toString('utf8')).toMatch(/^<!DOCTYPE HTML PUBLIC "-\/\/W3C\/\/DTD HTML 4\.0 Transitional\/\/EN">/);
    expect(content.toString('utf8')).toMatch(/<\/BODY>\n<\/HTML>$/);
  });

  it('removes the temporary split-parts directory when extraction fails', async () => {
    const partOne = path.join(tmpDir, 'failed-split-source-z01');
    const terminal = path.join(tmpDir, 'failed-split-source-zip');
    await fsPromises.writeFile(partOne, 'part one');
    await fsPromises.writeFile(terminal, 'terminal');
    let entryPath: string | undefined;
    const process7z = vi
      .spyOn(service as unknown as {
        process7z: (archivePath: string, extractDir: string) => Promise<FileManifest>;
      }, 'process7z')
      .mockImplementation(async (archivePath) => {
        entryPath = archivePath;
        throw new Error('split extraction failed');
      });

    await expect(service.processMultipartArchives(
      [
        { tempFilePath: partOne, originalFilename: 'bundle.z01' },
        { tempFilePath: terminal, originalFilename: 'bundle.zip' },
      ],
      path.join(tmpDir, 'failed-split-output'),
      'split',
    )).rejects.toThrow('split extraction failed');

    expect(entryPath).toBeDefined();
    await expect(fsPromises.access(path.dirname(entryPath!))).rejects.toThrow();
    process7z.mockRestore();
  });

  it('removes the temporary RAR parts directory when extraction fails', async () => {
    const partOne = path.join(tmpDir, 'failed-rar-source-part1');
    const partTwo = path.join(tmpDir, 'failed-rar-source-part2');
    await fsPromises.writeFile(partOne, 'part one');
    await fsPromises.writeFile(partTwo, 'part two');
    let entryPath: string | undefined;
    const process7z = vi
      .spyOn(service as unknown as {
        process7z: (archivePath: string, extractDir: string) => Promise<FileManifest>;
      }, 'process7z')
      .mockImplementation(async (archivePath) => {
        entryPath = archivePath;
        throw new Error('RAR volume extraction failed');
      });

    await expect(service.processMultipartArchives(
      [
        { tempFilePath: partTwo, originalFilename: 'bundle.part2.rar' },
        { tempFilePath: partOne, originalFilename: 'bundle.part1.rar' },
      ],
      path.join(tmpDir, 'failed-rar-output'),
      'split',
    )).rejects.toThrow('RAR volume extraction failed');

    expect(entryPath).toBeDefined();
    await expect(fsPromises.access(path.dirname(entryPath!))).rejects.toThrow();
    process7z.mockRestore();
  });

  it('extracts a real classic .z01 + terminal .zip fixture', async () => {
    const fixtureDir = path.join(tmpDir, 'real-classic');
    const sourceDir = path.join(fixtureDir, 'source');
    await fsPromises.mkdir(sourceDir, { recursive: true });
    await fsPromises.writeFile(path.join(sourceDir, 'payload.stl'), crypto.randomBytes(180_000));
    const archivePath = path.join(fixtureDir, 'bundle.zip');
    await execFileAsync('zip', ['-q', '-s', '64k', archivePath, 'payload.stl'], {
      cwd: sourceDir,
    });
    const names = (await fsPromises.readdir(fixtureDir)).filter((name) => /^bundle\.(?:z\d{2}|zip)$/i.test(name));
    expect(names.some((name) => /\.z01$/i.test(name))).toBe(true);

    const manifest = await service.processMultipartArchives(
      names.reverse().map((name) => ({
        tempFilePath: path.join(fixtureDir, name),
        originalFilename: name.replace('bundle', 'BuNdLe'),
      })),
      path.join(fixtureDir, 'extracted'),
      'split',
    );

    expect(manifest.entries).toEqual([
      expect.objectContaining({ filename: 'payload.stl', sizeBytes: 180_000 }),
    ]);
  });

  it('should extract a real numbered .zip.001 fixture generated by full 7-Zip', async () => {
    const fixtureDir = path.join(tmpDir, 'real-numbered');
    const sourceDir = path.join(fixtureDir, 'source');
    await fsPromises.mkdir(sourceDir, { recursive: true });
    await fsPromises.writeFile(path.join(sourceDir, 'payload.stl'), crypto.randomBytes(180_000));
    const archivePath = path.join(fixtureDir, 'bundle.zip');
    await execFileAsync(path7z, ['a', '-tzip', '-v64k', archivePath, 'payload.stl'], {
      cwd: sourceDir,
    });
    const names = (await fsPromises.readdir(fixtureDir)).filter((name) => /^bundle\.zip\.\d{3}$/i.test(name));
    expect(names.some((name) => /\.001$/i.test(name))).toBe(true);

    const manifest = await service.processMultipartArchives(
      names.reverse().map((name, index) => ({
        tempFilePath: path.join(fixtureDir, name),
        originalFilename: index % 2 === 0 ? name.toUpperCase() : name,
      })),
      path.join(fixtureDir, 'extracted'),
      'split',
    );

    expect(manifest.entries).toEqual([
      expect.objectContaining({ filename: 'payload.stl', sizeBytes: 180_000 }),
    ]);
  });
});

describe('7-Zip extraction preflight', () => {
  it('should bundle an extractor with RAR and RAR5 support', async () => {
    const { stdout } = await execFileAsync(path7z, ['i']);

    expect(stdout).toMatch(/^\s*\.\.\.F.*\sRar\s/m);
    expect(stdout).toMatch(/^\s*\.\.\.F.*\sRar5\s/m);
  });

  it.each([
    '../escape.stl',
    'safe/../../escape.stl',
    '/absolute/escape.stl',
    'C:\\escape.stl',
    '\\\\server\\share\\escape.stl',
  ])('rejects unsafe member path %s', (file) => {
    expect(() => validate7zArchiveEntry({ file })).toThrow();
  });

  it.each([
    new Map([['Symbolic Link', 'target']]),
    new Map([['Hard Link', 'target']]),
    new Map([['Mode', '0lrwxrwxrwx']]),
    new Map([['Attributes', 'A_ lrwxr-xr-x']]),
    new Map([['Reparse Point', 'junction-target']]),
  ])('rejects link/reparse listing metadata', (techInfo) => {
    expect(() => validate7zArchiveEntry({ file: 'safe.stl', techInfo })).toThrow();
  });

  it('allows a normal relative file', () => {
    expect(() => validate7zArchiveEntry({
      file: 'folder/model.stl',
      techInfo: new Map([['Mode', '0rw-r--r--']]),
    })).not.toThrow();
  });

  it.each([
    ['path traversal', { file: '../escape.stl' }],
    ['symbolic-link metadata', {
      file: 'safe-link.stl',
      techInfo: new Map([['Symbolic Link', 'target.stl']]),
    }],
    ['hard-link metadata', {
      file: 'safe-link.stl',
      techInfo: new Map([['Hard Link', 'target.stl']]),
    }],
  ])('rejects %s during listing before invoking extraction', async (_label, unsafeEntry) => {
    const listing = new EventEmitter();
    const list = vi.spyOn(Seven, 'list').mockImplementation(() => {
      queueMicrotask(() => {
        listing.emit('data', unsafeEntry);
        listing.emit('end');
      });
      return listing as never;
    });
    const extract = vi.spyOn(Seven, 'extractFull');

    try {
      await expect(service.processArchive(
        path.join(tmpDir, 'unsafe-listing.7z'),
        path.join(tmpDir, 'unsafe-listing-output'),
      )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(list).toHaveBeenCalledOnce();
      expect(extract).not.toHaveBeenCalled();
    } finally {
      list.mockRestore();
      extract.mockRestore();
    }
  });

  it('rejects a real symlink-preserving ZIP before invoking extraction', async () => {
    const fixtureDir = path.join(tmpDir, 'malicious-symlink-zip');
    const sourceDir = path.join(fixtureDir, 'source');
    await fsPromises.mkdir(sourceDir, { recursive: true });
    await fsPromises.writeFile(path.join(sourceDir, 'target.stl'), 'safe target');
    await fsPromises.symlink('target.stl', path.join(sourceDir, 'link.stl'));
    const archivePath = path.join(fixtureDir, 'symlink.zip');
    await execFileAsync('zip', ['-q', '-y', archivePath, 'target.stl', 'link.stl'], {
      cwd: sourceDir,
    });
    const extract7z = vi.spyOn(service as unknown as {
      extract7z: (archive: string, destination: string) => Promise<void>;
    }, 'extract7z');

    await expect((service as unknown as {
      process7z: (archive: string, destination: string) => Promise<FileManifest>;
    }).process7z(
      archivePath,
      path.join(fixtureDir, 'extracted'),
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(extract7z).not.toHaveBeenCalled();
    extract7z.mockRestore();
  });
});
