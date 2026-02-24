import { SUPPORTED_ARCHIVE_EXTENSIONS } from '@alexandria/shared';
import type { SupportedArchiveExtension } from '@alexandria/shared';

/**
 * Detect the archive extension from a filename.
 * Iterates in longest-match order so `.tar.gz` is matched before `.gz`.
 * Returns `null` for unsupported formats.
 */
export function detectArchiveExtension(filename: string): SupportedArchiveExtension | null {
  const lower = filename.toLowerCase();
  for (const ext of SUPPORTED_ARCHIVE_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return ext;
    }
  }
  return null;
}

/**
 * Strip the detected archive extension from a filename.
 * Used to derive the model name from the uploaded archive filename.
 * If no supported extension is detected, returns the filename unchanged.
 */
export function stripArchiveExtension(filename: string): string {
  const ext = detectArchiveExtension(filename);
  if (!ext) return filename;
  return filename.slice(0, filename.length - ext.length);
}
