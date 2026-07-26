import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { DetectedMetadataFile } from '@alexandria/shared';
import { metadataFileSchema } from '@alexandria/shared';
import { createLogger } from './logger.js';

const log = createLogger('metadata-file');

export const METADATA_FILENAME = 'metadata.json';

/**
 * Cap on a metadata.json worth parsing. The file describes one model, so
 * anything larger is not a hand-written metadata file.
 */
export const MAX_METADATA_FILE_BYTES = 64 * 1024;

/**
 * Read an archive root's metadata.json, for review-form prefill only.
 *
 * Best-effort by design: an unreadable, oversized, or malformed file is
 * skipped rather than failing the scan, because detection must never break an
 * upload that would otherwise have succeeded. Only the archive root is
 * consulted — a nested metadata.json belongs to whatever the archive packages,
 * not to the upload as a whole.
 */
export async function readMetadataFile(
  rootDir: string,
): Promise<DetectedMetadataFile | undefined> {
  const filePath = path.join(rootDir, METADATA_FILENAME);
  try {
    const stats = await fsPromises.stat(filePath);
    if (!stats.isFile()) return undefined;
    if (stats.size > MAX_METADATA_FILE_BYTES) {
      log.debug({ filePath, size: stats.size }, 'Ignoring oversized metadata.json');
      return undefined;
    }

    const parsed: unknown = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      log.debug({ filePath }, 'Ignoring metadata.json: expected a JSON object');
      return undefined;
    }

    const result = metadataFileSchema.safeParse(parsed);
    if (!result.success) return undefined;

    // Fields that failed their own validation catch to undefined; drop them so
    // the prefill payload carries only values that survived.
    return Object.fromEntries(
      Object.entries(result.data).filter(([, value]) => value !== undefined),
    ) as DetectedMetadataFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.debug({ filePath, error }, 'Ignoring unreadable metadata.json');
    }
    return undefined;
  }
}
