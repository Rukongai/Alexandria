import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index';

const { Pool } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://alexandria:alexandria@localhost:5432/alexandria';

// Shared pg connection pool — reused across all queries
export const pool = new Pool({
  connectionString: DATABASE_URL,
});

// Drizzle instance with full schema for typed queries
export const db = drizzle(pool, { schema });

export type Database = typeof db;
