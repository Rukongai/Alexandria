import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  HardlinkStrategy,
  CopyStrategy,
  MoveStrategy,
  createImportStrategy,
} from './import-strategy.service.js';

const TMP_ROOT = process.env.TMPDIR ?? '/private/tmp/claude-501/';

async function makeTmpDir(prefix: string): Promise<string> {
  return fsPromises.mkdtemp(path.join(TMP_ROOT, `alexandria-test-${prefix}-`));
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, content, 'utf8');
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readContent(filePath: string): Promise<string> {
  return fsPromises.readFile(filePath, 'utf8');
}

describe('HardlinkStrategy', () => {
  let tmpDir: string;
  let sourceFile: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir('hardlink');
    sourceFile = path.join(tmpDir, 'source', 'file.txt');
    await writeFile(sourceFile, 'hardlink test content');
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('should create a hardlink at the target path', async () => {
    const strategy = new HardlinkStrategy();
    const targetFile = path.join(tmpDir, 'target', 'file.txt');

    await strategy.execute(sourceFile, targetFile);

    expect(await exists(targetFile)).toBe(true);
    expect(await readContent(targetFile)).toBe('hardlink test content');
  });

  it('should create target parent directories that do not exist', async () => {
    const strategy = new HardlinkStrategy();
    const targetFile = path.join(tmpDir, 'deep', 'nested', 'dir', 'file.txt');

    await strategy.execute(sourceFile, targetFile);

    expect(await exists(targetFile)).toBe(true);
  });

  it('should produce a hardlink so both source and target share the same inode', async () => {
    const strategy = new HardlinkStrategy();
    const targetFile = path.join(tmpDir, 'target', 'file.txt');

    await strategy.execute(sourceFile, targetFile);

    const sourceStat = await fsPromises.stat(sourceFile);
    const targetStat = await fsPromises.stat(targetFile);

    // Hardlinks share the same inode number
    expect(targetStat.ino).toBe(sourceStat.ino);
  });

  it('should fall back to copy on EXDEV error and file content is preserved', async () => {
    const strategy = new HardlinkStrategy();
    const targetFile = path.join(tmpDir, 'target', 'file.txt');

    // Patch fs/promises link to simulate EXDEV (cross-device link error)
    const originalLink = fsPromises.link.bind(fsPromises);
    let linkCalled = false;
    (fsPromises as any).link = async (_src: string, _dest: string): Promise<void> => {
      linkCalled = true;
      const err = Object.assign(new Error('EXDEV: cross device link'), { code: 'EXDEV' });
      throw err;
    };

    try {
      await strategy.execute(sourceFile, targetFile);
    } finally {
      fsPromises.link = originalLink;
    }

    expect(linkCalled).toBe(true);
    expect(await exists(targetFile)).toBe(true);
    expect(await readContent(targetFile)).toBe('hardlink test content');
  });

  it('should rethrow errors other than EXDEV', async () => {
    const strategy = new HardlinkStrategy();
    const targetFile = path.join(tmpDir, 'target', 'file.txt');

    const originalLink = fsPromises.link.bind(fsPromises);
    (fsPromises as any).link = async (_src: string, _dest: string): Promise<void> => {
      const err = Object.assign(new Error('EPERM: permission denied'), { code: 'EPERM' });
      throw err;
    };

    try {
      await expect(strategy.execute(sourceFile, targetFile)).rejects.toMatchObject({
        code: 'EPERM',
      });
    } finally {
      fsPromises.link = originalLink;
    }
  });
});

describe('CopyStrategy', () => {
  let tmpDir: string;
  let sourceFile: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir('copy');
    sourceFile = path.join(tmpDir, 'source', 'file.txt');
    await writeFile(sourceFile, 'copy test content');
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('should copy the file to the target path', async () => {
    const strategy = new CopyStrategy();
    const targetFile = path.join(tmpDir, 'target', 'file.txt');

    await strategy.execute(sourceFile, targetFile);

    expect(await exists(targetFile)).toBe(true);
    expect(await readContent(targetFile)).toBe('copy test content');
  });

  it('should create target parent directories that do not exist', async () => {
    const strategy = new CopyStrategy();
    const targetFile = path.join(tmpDir, 'a', 'b', 'c', 'file.txt');

    await strategy.execute(sourceFile, targetFile);

    expect(await exists(targetFile)).toBe(true);
  });

  it('should leave the source file intact after copying', async () => {
    const strategy = new CopyStrategy();
    const targetFile = path.join(tmpDir, 'target', 'file.txt');

    await strategy.execute(sourceFile, targetFile);

    expect(await exists(sourceFile)).toBe(true);
    expect(await readContent(sourceFile)).toBe('copy test content');
  });

  it('should produce independent copies (different inodes)', async () => {
    const strategy = new CopyStrategy();
    const targetFile = path.join(tmpDir, 'target', 'file.txt');

    await strategy.execute(sourceFile, targetFile);

    const sourceStat = await fsPromises.stat(sourceFile);
    const targetStat = await fsPromises.stat(targetFile);

    expect(targetStat.ino).not.toBe(sourceStat.ino);
  });
});

describe('MoveStrategy', () => {
  let tmpDir: string;
  let sourceFile: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir('move');
    sourceFile = path.join(tmpDir, 'source', 'file.txt');
    await writeFile(sourceFile, 'move test content');
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('should move the file to the target path', async () => {
    const strategy = new MoveStrategy();
    const targetFile = path.join(tmpDir, 'target', 'file.txt');

    await strategy.execute(sourceFile, targetFile);

    expect(await exists(targetFile)).toBe(true);
    expect(await readContent(targetFile)).toBe('move test content');
  });

  it('should create target parent directories that do not exist', async () => {
    const strategy = new MoveStrategy();
    const targetFile = path.join(tmpDir, 'deep', 'nested', 'file.txt');

    await strategy.execute(sourceFile, targetFile);

    expect(await exists(targetFile)).toBe(true);
  });

  it('should remove the source file after moving', async () => {
    const strategy = new MoveStrategy();
    const targetFile = path.join(tmpDir, 'target', 'file.txt');

    await strategy.execute(sourceFile, targetFile);

    expect(await exists(sourceFile)).toBe(false);
  });

  it('should fall back to copy+unlink on EXDEV and source is removed', async () => {
    const strategy = new MoveStrategy();
    const targetFile = path.join(tmpDir, 'target', 'file.txt');

    const originalRename = fsPromises.rename.bind(fsPromises);
    let renameCalled = false;
    (fsPromises as any).rename = async (_src: string, _dest: string): Promise<void> => {
      renameCalled = true;
      const err = Object.assign(new Error('EXDEV: cross device link'), { code: 'EXDEV' });
      throw err;
    };

    try {
      await strategy.execute(sourceFile, targetFile);
    } finally {
      fsPromises.rename = originalRename;
    }

    expect(renameCalled).toBe(true);
    expect(await exists(targetFile)).toBe(true);
    expect(await readContent(targetFile)).toBe('move test content');
    expect(await exists(sourceFile)).toBe(false);
  });

  it('should rethrow errors other than EXDEV during rename', async () => {
    const strategy = new MoveStrategy();
    const targetFile = path.join(tmpDir, 'target', 'file.txt');

    const originalRename = fsPromises.rename.bind(fsPromises);
    (fsPromises as any).rename = async (_src: string, _dest: string): Promise<void> => {
      const err = Object.assign(new Error('EPERM: permission denied'), { code: 'EPERM' });
      throw err;
    };

    try {
      await expect(strategy.execute(sourceFile, targetFile)).rejects.toMatchObject({
        code: 'EPERM',
      });
    } finally {
      fsPromises.rename = originalRename;
    }
  });
});

describe('createImportStrategy', () => {
  it('should return HardlinkStrategy when strategy is "hardlink"', () => {
    expect(createImportStrategy('hardlink')).toBeInstanceOf(HardlinkStrategy);
  });

  it('should return CopyStrategy when strategy is "copy"', () => {
    expect(createImportStrategy('copy')).toBeInstanceOf(CopyStrategy);
  });

  it('should return MoveStrategy when strategy is "move"', () => {
    expect(createImportStrategy('move')).toBeInstanceOf(MoveStrategy);
  });

  it('should throw when strategy name is unknown', () => {
    expect(() => createImportStrategy('symlink')).toThrow('Unknown import strategy: symlink');
  });

  it('should throw when strategy name is empty string', () => {
    expect(() => createImportStrategy('')).toThrow();
  });
});
