import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createLogger } from '../utils/logger.js';
import { validationError } from '../utils/errors.js';

const logger = createLogger('ImportStrategy');

/**
 * Interface for import strategies that move files from a source location
 * into Alexandria's managed storage.
 */
export interface IImportStrategy {
  execute(sourcePath: string, targetPath: string): Promise<void>;
}

/**
 * Creates a hardlink from source to target. Validates same-filesystem
 * requirement. Falls back to copy with a warning if hardlinking fails.
 */
export class HardlinkStrategy implements IImportStrategy {
  async execute(sourcePath: string, targetPath: string): Promise<void> {
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });

    try {
      await fsPromises.link(sourcePath, targetPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EXDEV = cross-device link (different filesystem)
      if (code === 'EXDEV') {
        logger.warn(
          { sourcePath, targetPath },
          'Hardlink failed (cross-device), falling back to copy',
        );
        await copyFile(sourcePath, targetPath);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Copies files from source to managed storage. Safe default strategy.
 */
export class CopyStrategy implements IImportStrategy {
  async execute(sourcePath: string, targetPath: string): Promise<void> {
    await copyFile(sourcePath, targetPath);
  }
}

/**
 * Moves files from source into managed storage. Destructive to originals.
 */
export class MoveStrategy implements IImportStrategy {
  async execute(sourcePath: string, targetPath: string): Promise<void> {
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });

    try {
      // rename is atomic on same filesystem
      await fsPromises.rename(sourcePath, targetPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EXDEV = cross-device, can't rename across filesystems
      if (code === 'EXDEV') {
        await copyFile(sourcePath, targetPath);
        await fsPromises.unlink(sourcePath);
      } else {
        throw err;
      }
    }
  }
}

async function copyFile(sourcePath: string, targetPath: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
  const readStream = fs.createReadStream(sourcePath);
  const writeStream = fs.createWriteStream(targetPath);
  await pipeline(readStream, writeStream);
}

/**
 * Factory to create the correct strategy from a strategy name.
 */
export function createImportStrategy(strategy: string): IImportStrategy {
  switch (strategy) {
    case 'hardlink':
      return new HardlinkStrategy();
    case 'copy':
      return new CopyStrategy();
    case 'move':
      return new MoveStrategy();
    default:
      throw validationError(`Unknown import strategy: ${strategy}`, 'strategy');
  }
}
