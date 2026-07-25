import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { config } from '../config/index.js';
import {
  DATABASE_CONNECTION_TIMEOUT_MS,
  DATABASE_QUERY_TIMEOUT_MS,
  DATABASE_STATEMENT_TIMEOUT_MS,
  createDatabasePoolOptions,
  pool,
} from './index.js';

const { Client } = pg;

function resolvedSsl(options: pg.ClientConfig): unknown {
  const client = new Client(options) as pg.Client & {
    connectionParameters: { ssl: unknown };
  };
  return client.connectionParameters.ssl;
}

describe('database execution bounds', () => {
  it('configures server statement and client query timeouts', () => {
    expect(pool.options.statement_timeout).toBe(DATABASE_STATEMENT_TIMEOUT_MS);
    expect(pool.options.query_timeout).toBe(DATABASE_QUERY_TIMEOUT_MS);
    expect(pool.options.connectionTimeoutMillis).toBe(DATABASE_CONNECTION_TIMEOUT_MS);
    expect(DATABASE_STATEMENT_TIMEOUT_MS).toBeLessThanOrEqual(45_000);
    expect(DATABASE_QUERY_TIMEOUT_MS).toBeGreaterThanOrEqual(DATABASE_STATEMENT_TIMEOUT_MS);
    expect(DATABASE_CONNECTION_TIMEOUT_MS).toBeLessThan(DATABASE_STATEMENT_TIMEOUT_MS);
  });

  it('should configure the application connection-pool maximum', () => {
    expect(pool.options.max).toBe(config.databasePoolMax);
    expect(createDatabasePoolOptions({
      databaseUrl: 'postgresql://user:password@localhost:5432/alexandria',
      databasePoolMax: 4,
    }).max).toBe(4);
  });
});

describe('hosted database TLS configuration', () => {
  it('should leave TLS policy to DATABASE_URL sslmode semantics', () => {
    const disabledOptions = createDatabasePoolOptions({
      databaseUrl: 'postgresql://user:password@localhost:5432/alexandria?sslmode=disable',
      databasePoolMax: 5,
    });
    const verifiedOptions = createDatabasePoolOptions({
      databaseUrl: 'postgresql://user:password@db.example.com:5432/alexandria?sslmode=verify-full',
      databasePoolMax: 5,
    });

    expect(disabledOptions).not.toHaveProperty('ssl');
    expect(verifiedOptions).not.toHaveProperty('ssl');
    expect(resolvedSsl(disabledOptions)).toBe(false);
    expect(resolvedSsl(verifiedOptions)).toEqual({});
  });
});
