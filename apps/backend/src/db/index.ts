import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index';
import { config } from '../config/index.js';

const { Pool } = pg;

// Shared pg connection pool — reused across all queries
export const pool = new Pool({
  connectionString: config.databaseUrl,
});

// Drizzle instance with full schema for typed queries
export const db = drizzle(pool, { schema });

export type Database = typeof db;
