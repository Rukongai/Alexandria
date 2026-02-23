import type { ParsedPatternSegment } from '@alexandria/shared';
import { validationError } from './errors.js';

/**
 * Parses a hierarchy pattern string into structured segments.
 *
 * Valid segments:
 *   {model}                — the model root directory (must be last)
 *   {Collection}           — a collection assignment
 *   {metadata.<fieldSlug>} — a metadata value extracted from the directory name
 *
 * Validation rules:
 *   - Pattern must contain at least one segment
 *   - Pattern must end with {model}
 *   - {model} cannot appear in the middle
 *   - All segments must be one of the valid types above
 *
 * Example: "{Collection}/{metadata.artist}/{model}"
 *   → [{ type: 'collection' }, { type: 'metadata', metadataSlug: 'artist' }, { type: 'model' }]
 */
export function parsePattern(pattern: string): ParsedPatternSegment[] {
  const trimmed = pattern.trim();
  if (!trimmed) {
    throw validationError('Pattern cannot be empty', 'pattern');
  }

  const rawSegments = trimmed.split('/').filter((s) => s.length > 0);

  if (rawSegments.length === 0) {
    throw validationError('Pattern must contain at least one segment', 'pattern');
  }

  const lastSegment = rawSegments[rawSegments.length - 1];
  if (lastSegment.toLowerCase() !== '{model}') {
    throw validationError(
      'Pattern must end with {model}',
      'pattern',
    );
  }

  const parsed: ParsedPatternSegment[] = [];

  for (let i = 0; i < rawSegments.length; i++) {
    const segment = rawSegments[i];
    const isLast = i === rawSegments.length - 1;

    if (segment.toLowerCase() === '{model}') {
      if (!isLast) {
        throw validationError(
          '{model} must be the last segment in the pattern',
          'pattern',
        );
      }
      parsed.push({ type: 'model' });
      continue;
    }

    if (segment.toLowerCase() === '{collection}') {
      parsed.push({ type: 'collection' });
      continue;
    }

    // Check for {metadata.<fieldSlug>} pattern
    const metadataMatch = segment.match(/^\{metadata\.([a-zA-Z0-9_-]+)\}$/);
    if (metadataMatch) {
      parsed.push({ type: 'metadata', metadataSlug: metadataMatch[1] });
      continue;
    }

    throw validationError(
      `Invalid pattern segment: "${segment}". Must be {model}, {Collection}, or {metadata.<fieldSlug>}`,
      'pattern',
    );
  }

  return parsed;
}
