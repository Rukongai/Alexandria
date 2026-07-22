import { describe, expect, it } from 'vitest';
import {
  DATABASE_CONNECTION_TIMEOUT_MS,
  DATABASE_QUERY_TIMEOUT_MS,
  DATABASE_STATEMENT_TIMEOUT_MS,
  pool,
} from './index.js';

describe('database execution bounds', () => {
  it('configures server statement and client query timeouts', () => {
    expect(pool.options.statement_timeout).toBe(DATABASE_STATEMENT_TIMEOUT_MS);
    expect(pool.options.query_timeout).toBe(DATABASE_QUERY_TIMEOUT_MS);
    expect(pool.options.connectionTimeoutMillis).toBe(DATABASE_CONNECTION_TIMEOUT_MS);
    expect(DATABASE_STATEMENT_TIMEOUT_MS).toBeLessThanOrEqual(45_000);
    expect(DATABASE_QUERY_TIMEOUT_MS).toBeGreaterThanOrEqual(DATABASE_STATEMENT_TIMEOUT_MS);
    expect(DATABASE_CONNECTION_TIMEOUT_MS).toBeLessThan(DATABASE_STATEMENT_TIMEOUT_MS);
  });
});
