import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import archiver from 'archiver';
import { FileProcessingService } from './file-processing.service.js';

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let service: FileProcessingService;

beforeAll(async () => {
  tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'alex-fp-test-'));
  service = new FileProcessingService();
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

    const manifest = await service.processZip(zipPath, extractDir);

    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].fileType).toBe('stl');
    expect(manifest.entries[0].mimeType).toBe('model/stl');
  });

  it('should classify .jpg files as image', async () => {
    const zipPath = path.join(tmpDir, 'jpg.zip');
    const extractDir = path.join(tmpDir, 'jpg-extract');

    await createTestZip(zipPath, [{ name: 'photo.jpg', content: 'fake-jpg-data' }]);

    const manifest = await service.processZip(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('image');
    expect(manifest.entries[0].mimeType).toBe('image/jpeg');
  });

  it('should classify .jpeg files as image', async () => {
    const zipPath = path.join(tmpDir, 'jpeg.zip');
    const extractDir = path.join(tmpDir, 'jpeg-extract');

    await createTestZip(zipPath, [{ name: 'photo.jpeg', content: 'fake-jpeg-data' }]);

    const manifest = await service.processZip(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('image');
  });

  it('should classify .png files as image', async () => {
    const zipPath = path.join(tmpDir, 'png.zip');
    const extractDir = path.join(tmpDir, 'png-extract');

    await createTestZip(zipPath, [{ name: 'photo.png', content: 'fake-png-data' }]);

    const manifest = await service.processZip(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('image');
    expect(manifest.entries[0].mimeType).toBe('image/png');
  });

  it('should classify .webp files as image', async () => {
    const zipPath = path.join(tmpDir, 'webp.zip');
    const extractDir = path.join(tmpDir, 'webp-extract');

    await createTestZip(zipPath, [{ name: 'photo.webp', content: 'fake-webp-data' }]);

    const manifest = await service.processZip(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('image');
    expect(manifest.entries[0].mimeType).toBe('image/webp');
  });

  it('should classify .tif files as image', async () => {
    const zipPath = path.join(tmpDir, 'tif.zip');
    const extractDir = path.join(tmpDir, 'tif-extract');

    await createTestZip(zipPath, [{ name: 'scan.tif', content: 'fake-tif-data' }]);

    const manifest = await service.processZip(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('image');
    expect(manifest.entries[0].mimeType).toBe('image/tiff');
  });

  it('should classify .pdf files as document', async () => {
    const zipPath = path.join(tmpDir, 'pdf.zip');
    const extractDir = path.join(tmpDir, 'pdf-extract');

    await createTestZip(zipPath, [{ name: 'readme.pdf', content: '%PDF-1.4 fake' }]);

    const manifest = await service.processZip(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('document');
    expect(manifest.entries[0].mimeType).toBe('application/pdf');
  });

  it('should classify .txt files as document', async () => {
    const zipPath = path.join(tmpDir, 'txt.zip');
    const extractDir = path.join(tmpDir, 'txt-extract');

    await createTestZip(zipPath, [{ name: 'notes.txt', content: 'some notes' }]);

    const manifest = await service.processZip(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('document');
    expect(manifest.entries[0].mimeType).toBe('text/plain');
  });

  it('should classify .md files as document', async () => {
    const zipPath = path.join(tmpDir, 'md.zip');
    const extractDir = path.join(tmpDir, 'md-extract');

    await createTestZip(zipPath, [{ name: 'README.md', content: '# Hello' }]);

    const manifest = await service.processZip(zipPath, extractDir);

    expect(manifest.entries[0].fileType).toBe('document');
    expect(manifest.entries[0].mimeType).toBe('text/markdown');
  });

  it('should classify unknown extensions as other', async () => {
    const zipPath = path.join(tmpDir, 'other.zip');
    const extractDir = path.join(tmpDir, 'other-extract');

    await createTestZip(zipPath, [{ name: 'data.bin', content: 'binary data' }]);

    const manifest = await service.processZip(zipPath, extractDir);

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

    const manifest = await service.processZip(zipPath, extractDir);

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

    const manifest = await service.processZip(zipPath, extractDir);

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

    const manifest = await service.processZip(zipPath, extractDir);

    const names = manifest.entries.map((e) => e.filename);
    expect(names).toContain('model.stl');
    expect(names).not.toContain('._model.stl');
    expect(manifest.entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Full manifest correctness
// ---------------------------------------------------------------------------

describe('FileProcessingService – processZip manifest', () => {
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

    const manifest = await service.processZip(zipPath, extractDir);

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
