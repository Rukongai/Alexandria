import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { PoolConfig } from 'pg';
import * as schema from './schema/index.js';
import { config, type AppConfig } from '../config/index.js';

const { Pool } = pg;

export const DATABASE_STATEMENT_TIMEOUT_MS = 45_000;
export const DATABASE_QUERY_TIMEOUT_MS = 50_000;
export const DATABASE_CONNECTION_TIMEOUT_MS = 5_000;

type DatabaseConnectionConfig = Pick<AppConfig, 'databaseUrl' | 'databasePoolMax'>;

export function createDatabasePoolOptions(
  databaseConfig: DatabaseConnectionConfig,
): PoolConfig {
  return {
    connectionString: databaseConfig.databaseUrl,
    max: databaseConfig.databasePoolMax,
    // Bound server execution and client-side waits even when an HTTP caller has
    // already disconnected. Assistant-level races return sooner when needed.
    statement_timeout: DATABASE_STATEMENT_TIMEOUT_MS,
    query_timeout: DATABASE_QUERY_TIMEOUT_MS,
    connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MS,
  };
}

// Shared pg connection pool — reused across all queries
// TLS is intentionally not set here: node-postgres parses sslmode, sslrootcert,
// sslcert, and sslkey from DATABASE_URL without an application option overriding
// the hosted provider's connection-string semantics.
export const pool = new Pool(createDatabasePoolOptions(config));

// Drizzle instance with full schema for typed queries
export const db = drizzle(pool, { schema });

export type Database = typeof db;
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DatabaseExecutor = Database | DatabaseTransaction;
