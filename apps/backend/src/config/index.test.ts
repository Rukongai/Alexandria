import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DATABASE_POOL_MAX,
  resolveAiEncryptionKey,
  resolveAllowPrivateProviderUrls,
  resolveDatabasePoolMax,
} from './index.js';

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
