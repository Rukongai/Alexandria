import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { FileProcessingService } from './file-processing.service.js';
import { parsePattern } from '../utils/pattern-parser.js';
import type { ParsedPatternSegment } from '@alexandria/shared';

const TMP_ROOT = process.env.TMPDIR ?? '/private/tmp/claude-501/';

async function makeTmpDir(prefix: string): Promise<string> {
  return fsPromises.mkdtemp(path.join(TMP_ROOT, `alexandria-folder-import-${prefix}-`));
}

/**
 * Creates a directory structure under baseDir.
 * The paths array is a list of relative directory paths to create.
 * Files placed inside are minimal placeholders so the directories are populated.
 */
async function makeStructure(baseDir: string, dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    const fullPath = path.join(baseDir, dir);
    await fsPromises.mkdir(fullPath, { recursive: true });
  }
}

describe('FileProcessingService.walkDirectoryForImport', () => {
  let service: FileProcessingService;
  let tmpDir: string;

  beforeEach(async () => {
    service = new FileProcessingService();
    tmpDir = await makeTmpDir('walk');
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  describe('pattern {model}', () => {
    it('should discover directories at root level as models', async () => {
      await makeStructure(tmpDir, [
        'Benchy',
        'Marvin',
        'VoronParts',
      ]);

      const pattern = parsePattern('{model}');
      const result = await service.walkDirectoryForImport(tmpDir, pattern);

      const names = result.map((m) => m.name).sort();
      expect(names).toEqual(['Benchy', 'Marvin', 'VoronParts']);
    });

    it('should set collectionName to null and metadata to empty object for {model} pattern', async () => {
      await makeStructure(tmpDir, ['Benchy']);

      const pattern = parsePattern('{model}');
      const result = await service.walkDirectoryForImport(tmpDir, pattern);

      expect(result).toHaveLength(1);
      expect(result[0].collectionName).toBeNull();
      expect(result[0].metadata).toEqual({});
    });

    it('should set sourcePath to the absolute path of the model directory', async () => {
      await makeStructure(tmpDir, ['Benchy']);

      const pattern = parsePattern('{model}');
      const result = await service.walkDirectoryForImport(tmpDir, pattern);

      expect(result[0].sourcePath).toBe(path.join(tmpDir, 'Benchy'));
    });
  });

  describe('pattern {metadata.artist}/{model}', () => {
    it('should discover models with artist metadata extracted from parent directory name', async () => {
      await makeStructure(tmpDir, [
        'Lychee/Benchy',
        'Lychee/Marvin',
        'Prusa/VoronParts',
      ]);

      const pattern = parsePattern('{metadata.artist}/{model}');
      const result = await service.walkDirectoryForImport(tmpDir, pattern);

      expect(result).toHaveLength(3);

      const benchy = result.find((m) => m.name === 'Benchy');
      expect(benchy).toBeDefined();
      expect(benchy!.metadata).toEqual({ artist: 'Lychee' });
      expect(benchy!.collectionName).toBeNull();

      const voron = result.find((m) => m.name === 'VoronParts');
      expect(voron!.metadata).toEqual({ artist: 'Prusa' });
    });

    it('should set sourcePath to the absolute path under the artist directory', async () => {
      await makeStructure(tmpDir, ['Lychee/Benchy']);

      const pattern = parsePattern('{metadata.artist}/{model}');
      const result = await service.walkDirectoryForImport(tmpDir, pattern);

      expect(result[0].sourcePath).toBe(path.join(tmpDir, 'Lychee', 'Benchy'));
    });
  });

  describe('pattern {Collection}/{metadata.artist}/{model}', () => {
    it('should discover models with collection name and artist metadata', async () => {
      await makeStructure(tmpDir, [
        'FDM/Lychee/Benchy',
        'FDM/Prusa/VoronParts',
        'Resin/AnyCubic/Dragon',
      ]);

      const pattern = parsePattern('{Collection}/{metadata.artist}/{model}');
      const result = await service.walkDirectoryForImport(tmpDir, pattern);

      expect(result).toHaveLength(3);

      const benchy = result.find((m) => m.name === 'Benchy');
      expect(benchy).toBeDefined();
      expect(benchy!.collectionName).toBe('FDM');
      expect(benchy!.metadata).toEqual({ artist: 'Lychee' });

      const dragon = result.find((m) => m.name === 'Dragon');
      expect(dragon!.collectionName).toBe('Resin');
      expect(dragon!.metadata).toEqual({ artist: 'AnyCubic' });
    });

    it('should set sourcePath to the absolute path under collection/artist directories', async () => {
      await makeStructure(tmpDir, ['FDM/Lychee/Benchy']);

      const pattern = parsePattern('{Collection}/{metadata.artist}/{model}');
      const result = await service.walkDirectoryForImport(tmpDir, pattern);

      expect(result[0].sourcePath).toBe(path.join(tmpDir, 'FDM', 'Lychee', 'Benchy'));
    });
  });

  describe('edge cases', () => {
    it('should return empty array when source directory has no subdirectories', async () => {
      // tmpDir exists but is empty
      const pattern = parsePattern('{model}');
      const result = await service.walkDirectoryForImport(tmpDir, pattern);

      expect(result).toEqual([]);
    });

    it('should return empty array when source directory does not exist', async () => {
      const nonExistent = path.join(tmpDir, 'does-not-exist');
      const pattern = parsePattern('{model}');
      const result = await service.walkDirectoryForImport(nonExistent, pattern);

      expect(result).toEqual([]);
    });

    it('should skip hidden directories (starting with .)', async () => {
      await makeStructure(tmpDir, [
        '.hidden-model',
        '.git',
        'VisibleModel',
      ]);

      const pattern = parsePattern('{model}');
      const result = await service.walkDirectoryForImport(tmpDir, pattern);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('VisibleModel');
    });

    it('should skip hidden directories at intermediate pattern levels', async () => {
      await makeStructure(tmpDir, [
        '.hidden-artist/Benchy',
        'Lychee/Benchy',
      ]);

      const pattern = parsePattern('{metadata.artist}/{model}');
      const result = await service.walkDirectoryForImport(tmpDir, pattern);

      // Only models under visible artist directories are returned
      expect(result).toHaveLength(1);
      expect(result[0].metadata).toEqual({ artist: 'Lychee' });
    });

    it('should return empty array when source contains only files, not directories', async () => {
      await fsPromises.writeFile(path.join(tmpDir, 'some-file.txt'), 'content');

      const pattern = parsePattern('{model}');
      const result = await service.walkDirectoryForImport(tmpDir, pattern);

      expect(result).toEqual([]);
    });

    it('should not descend into model directories when counting models', async () => {
      // Model directories can contain nested structure — those nested dirs are
      // model content, not separate models
      await makeStructure(tmpDir, [
        'Benchy/parts/base',
        'Benchy/parts/chimney',
      ]);

      const pattern = parsePattern('{model}');
      const result = await service.walkDirectoryForImport(tmpDir, pattern);

      // Only Benchy is a model; its nested dirs are model content
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Benchy');
    });

    it('should accumulate metadata from multiple metadata segments', async () => {
      await makeStructure(tmpDir, ['Lychee/2023/Benchy']);

      const pattern = parsePattern('{metadata.artist}/{metadata.year}/{model}');
      const result = await service.walkDirectoryForImport(tmpDir, pattern);

      expect(result).toHaveLength(1);
      expect(result[0].metadata).toEqual({ artist: 'Lychee', year: '2023' });
    });

    it('should not share metadata state between sibling artist directories', async () => {
      await makeStructure(tmpDir, [
        'Lychee/ModelA',
        'Prusa/ModelB',
      ]);

      const pattern = parsePattern('{metadata.artist}/{model}');
      const result = await service.walkDirectoryForImport(tmpDir, pattern);

      const modelA = result.find((m) => m.name === 'ModelA');
      const modelB = result.find((m) => m.name === 'ModelB');

      expect(modelA!.metadata).toEqual({ artist: 'Lychee' });
      expect(modelB!.metadata).toEqual({ artist: 'Prusa' });
    });
  });
});
