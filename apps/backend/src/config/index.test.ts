import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DATABASE_POOL_MAX,
  DEFAULT_STORAGE_UPLOAD_CONCURRENCY,
  MAX_STORAGE_UPLOAD_CONCURRENCY,
  resolveAiEncryptionKey,
  resolveAllowPrivateProviderUrls,
  resolveDatabasePoolMax,
  resolveStorageUploadConcurrency,
} from './index.js';

describe('storage upload concurrency configuration', () => {
  it('should default when STORAGE_UPLOAD_CONCURRENCY is absent', () => {
    expect(resolveStorageUploadConcurrency(undefined)).toBe(DEFAULT_STORAGE_UPLOAD_CONCURRENCY);
    expect(resolveStorageUploadConcurrency('')).toBe(DEFAULT_STORAGE_UPLOAD_CONCURRENCY);
  });

  it('should accept a configured positive integer', () => {
    expect(resolveStorageUploadConcurrency('1')).toBe(1);
    expect(resolveStorageUploadConcurrency('16')).toBe(16);
    expect(resolveStorageUploadConcurrency(String(MAX_STORAGE_UPLOAD_CONCURRENCY))).toBe(
      MAX_STORAGE_UPLOAD_CONCURRENCY,
    );
  });

  it.each(['0', '-1', '1.5', 'eight', ' 4'])(
    'should reject invalid STORAGE_UPLOAD_CONCURRENCY value %j',
    (value) => {
      expect(() => resolveStorageUploadConcurrency(value)).toThrow(
        'STORAGE_UPLOAD_CONCURRENCY must be a positive integer',
      );
    },
  );

  it('should reject a value above the supported ceiling', () => {
    // An unbounded value would exhaust the socket pool rather than go faster.
    expect(() =>
      resolveStorageUploadConcurrency(String(MAX_STORAGE_UPLOAD_CONCURRENCY + 1)),
    ).toThrow('STORAGE_UPLOAD_CONCURRENCY must not exceed');
  });
});

describe('database configuration', () => {
  it('should preserve the node-postgres pool default when DATABASE_POOL_MAX is absent', () => {
    expect(resolveDatabasePoolMax(undefined)).toBe(DEFAULT_DATABASE_POOL_MAX);
    expect(resolveDatabasePoolMax('')).toBe(DEFAULT_DATABASE_POOL_MAX);
    expect(DEFAULT_DATABASE_POOL_MAX).toBe(10);
  });

  it('should accept a configured positive integer pool maximum', () => {
    expect(resolveDatabasePoolMax('1')).toBe(1);
    expect(resolveDatabasePoolMax('25')).toBe(25);
  });

  it.each(['0', '-1', '1.5', 'ten', ' 5', '9007199254740992'])(
    'should reject invalid DATABASE_POOL_MAX value %j',
    (value) => {
      expect(() => resolveDatabasePoolMax(value)).toThrow(
        'DATABASE_POOL_MAX must be a positive integer',
      );
    },
  );
});

describe('AI security configuration', () => {
  it('fails startup resolution when production encryption key is absent or short', () => {
    expect(() => resolveAiEncryptionKey('production', undefined, 'session-secret'))
      .toThrow('AI_ENCRYPTION_KEY is required');
    expect(() => resolveAiEncryptionKey('production', 'too-short', 'session-secret'))
      .toThrow('at least 32 characters');
    expect(() => resolveAiEncryptionKey('production', 'x'.repeat(32), 'x'.repeat(32)))
      .toThrow('separate from SESSION_SECRET');
    expect(() => resolveAiEncryptionKey(
      'production',
      'change-me-to-a-separate-long-random-secret',
      'session-secret',
    )).toThrow('known placeholder');
  });

  it('uses the session fallback only outside production', () => {
    expect(resolveAiEncryptionKey('development', undefined, 'session-secret'))
      .toBe('session-secret');
    expect(resolveAiEncryptionKey('production', 'x'.repeat(32), 'session-secret'))
      .toBe('x'.repeat(32));
  });

  it('allows private providers by development policy or explicit opt-in', () => {
    expect(resolveAllowPrivateProviderUrls('development', undefined)).toBe(true);
    expect(resolveAllowPrivateProviderUrls('production', undefined)).toBe(false);
    expect(resolveAllowPrivateProviderUrls('production', 'true')).toBe(true);
    expect(resolveAllowPrivateProviderUrls('development', 'false')).toBe(false);
  });
});
