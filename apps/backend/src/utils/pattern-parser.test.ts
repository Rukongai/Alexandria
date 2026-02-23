import { describe, it, expect } from 'vitest';
import { parsePattern } from './pattern-parser.js';
import { AppError } from './errors.js';

describe('parsePattern', () => {
  describe('valid patterns', () => {
    it('should return a single model segment when pattern is {model}', () => {
      const result = parsePattern('{model}');
      expect(result).toEqual([{ type: 'model' }]);
    });

    it('should return metadata and model segments when pattern is {metadata.artist}/{model}', () => {
      const result = parsePattern('{metadata.artist}/{model}');
      expect(result).toEqual([
        { type: 'metadata', metadataSlug: 'artist' },
        { type: 'model' },
      ]);
    });

    it('should return collection, metadata, and model segments when pattern is {Collection}/{metadata.artist}/{model}', () => {
      const result = parsePattern('{Collection}/{metadata.artist}/{model}');
      expect(result).toEqual([
        { type: 'collection' },
        { type: 'metadata', metadataSlug: 'artist' },
        { type: 'model' },
      ]);
    });

    it('should handle multiple metadata segments in sequence', () => {
      const result = parsePattern('{metadata.artist}/{metadata.year}/{model}');
      expect(result).toEqual([
        { type: 'metadata', metadataSlug: 'artist' },
        { type: 'metadata', metadataSlug: 'year' },
        { type: 'model' },
      ]);
    });

    it('should strip leading and trailing whitespace from the pattern', () => {
      const result = parsePattern('  {model}  ');
      expect(result).toEqual([{ type: 'model' }]);
    });

    it('should filter out empty segments caused by extra slashes', () => {
      // Extra slashes produce empty strings which are filtered before parsing
      const result = parsePattern('{metadata.artist}//{model}');
      expect(result).toEqual([
        { type: 'metadata', metadataSlug: 'artist' },
        { type: 'model' },
      ]);
    });

    it('should accept metadata slugs with hyphens and underscores', () => {
      const result = parsePattern('{metadata.my-field_slug}/{model}');
      expect(result).toEqual([
        { type: 'metadata', metadataSlug: 'my-field_slug' },
        { type: 'model' },
      ]);
    });
  });

  describe('case-insensitive matching', () => {
    it('should match {MODEL} case-insensitively', () => {
      const result = parsePattern('{MODEL}');
      expect(result).toEqual([{ type: 'model' }]);
    });

    it('should match {Model} case-insensitively', () => {
      const result = parsePattern('{Model}');
      expect(result).toEqual([{ type: 'model' }]);
    });

    it('should match {collection} lowercase as collection segment', () => {
      const result = parsePattern('{collection}/{model}');
      expect(result).toEqual([
        { type: 'collection' },
        { type: 'model' },
      ]);
    });

    it('should match {COLLECTION} uppercase as collection segment', () => {
      const result = parsePattern('{COLLECTION}/{model}');
      expect(result).toEqual([
        { type: 'collection' },
        { type: 'model' },
      ]);
    });
  });

  describe('invalid patterns', () => {
    it('should throw AppError when pattern is empty string', () => {
      expect(() => parsePattern('')).toThrow(AppError);
    });

    it('should throw AppError with field "pattern" when pattern is empty string', () => {
      try {
        parsePattern('');
        expect.fail('Expected parsePattern to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).field).toBe('pattern');
      }
    });

    it('should throw AppError when pattern is only whitespace', () => {
      expect(() => parsePattern('   ')).toThrow(AppError);
    });

    it('should throw AppError when pattern does not end with {model}', () => {
      expect(() => parsePattern('{metadata.artist}')).toThrow(AppError);
    });

    it('should throw AppError when {model} appears in the middle', () => {
      expect(() => parsePattern('{model}/{metadata.artist}')).toThrow(AppError);
    });

    it('should throw AppError when pattern contains an invalid literal segment', () => {
      expect(() => parsePattern('foo/{model}')).toThrow(AppError);
    });

    it('should throw AppError when pattern has bare text mixed with valid segments', () => {
      expect(() => parsePattern('{metadata.artist}/something/{model}')).toThrow(AppError);
    });

    it('should include field "pattern" on the thrown AppError for all invalid cases', () => {
      const cases = [
        '{metadata.artist}',
        '{model}/{metadata.artist}',
        'foo/{model}',
      ];

      for (const pattern of cases) {
        try {
          parsePattern(pattern);
          expect.fail(`Expected parsePattern("${pattern}") to throw`);
        } catch (err) {
          expect(err).toBeInstanceOf(AppError);
          expect((err as AppError).field).toBe('pattern');
        }
      }
    });

    it('should throw AppError with statusCode 400 for validation errors', () => {
      try {
        parsePattern('');
      } catch (err) {
        expect((err as AppError).statusCode).toBe(400);
      }
    });
  });
});
