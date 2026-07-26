import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { DetectedMetadataFile } from '@alexandria/shared';
import { metadataFileSchema } from '@alexandria/shared';
import { createLogger } from './logger.js';

const logger = createLogger('MetadataFile');

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
  try {
    const filePath = path.join(rootDir, METADATA_FILENAME);
    // lstat, not stat: FileProcessingService rejects symlinks during extraction
    // for the same reason, and one leaked through named metadata.json would
    // otherwise have its target read and surfaced into the review form.
    const stats = await fsPromises.lstat(filePath);
    if (!stats.isFile()) return undefined;
    if (stats.size > MAX_METADATA_FILE_BYTES) {
      logger.debug({ rootDir, size: stats.size }, 'Ignoring oversized metadata.json');
      return undefined;
    }

    const parsed: unknown = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      logger.debug({ rootDir }, 'Ignoring metadata.json: expected a JSON object');
      return undefined;
    }

    const result = metadataFileSchema.safeParse(parsed);
    if (!result.success) return undefined;

    // Fields that failed their own validation catch to undefined; drop them so
    // the prefill payload carries only values that survived.
    const usable = Object.fromEntries(
      Object.entries(result.data).filter(([, value]) => value !== undefined),
    ) as DetectedMetadataFile;

    // A file carrying nothing usable is not a detected metadata file, so
    // `metadataFile !== undefined` stays a reliable signal for consumers.
    return Object.keys(usable).length > 0 ? usable : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.debug({ rootDir, error }, 'Ignoring unreadable metadata.json');
    }
    return undefined;
  }
}
