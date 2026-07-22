import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';
import { config } from '../config/index.js';

const { Pool } = pg;

export const DATABASE_STATEMENT_TIMEOUT_MS = 45_000;
export const DATABASE_QUERY_TIMEOUT_MS = 50_000;
export const DATABASE_CONNECTION_TIMEOUT_MS = 5_000;

// Shared pg connection pool — reused across all queries
export const pool = new Pool({
  connectionString: config.databaseUrl,
  // Bound server execution and client-side waits even when an HTTP caller has
  // already disconnected. Assistant-level races return sooner when needed.
  statement_timeout: DATABASE_STATEMENT_TIMEOUT_MS,
  query_timeout: DATABASE_QUERY_TIMEOUT_MS,
  connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MS,
});

// Drizzle instance with full schema for typed queries
export const db = drizzle(pool, { schema });

export type Database = typeof db;
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DatabaseExecutor = Database | DatabaseTransaction;
