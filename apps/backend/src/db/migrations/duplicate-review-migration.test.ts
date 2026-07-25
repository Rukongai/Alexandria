import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const { Pool } = pg;

const TEST_DATABASE_URL =
  'postgresql://alexandria:alexandria@localhost:5433/alexandria_test';

let pool: pg.Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

describe('duplicate-review persistence migration', () => {
  it('adds non-null duplicate flags defaulted to false', async () => {
    const { rows } = await pool.query<{
      table_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(`
      SELECT table_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'is_duplicate'
        AND table_name IN ('models', 'model_files')
      ORDER BY table_name
    `);

    expect(rows).toEqual([
      { table_name: 'model_files', is_nullable: 'NO', column_default: 'false' },
      { table_name: 'models', is_nullable: 'NO', column_default: 'false' },
    ]);
  });

  it('creates library-scoped composite primary keys for ignored exact matches', async () => {
    const { rows } = await pool.query<{ table_name: string; definition: string }>(`
      SELECT conrelid::regclass::text AS table_name,
             pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE contype = 'p'
        AND conrelid IN (
          'duplicate_file_ignores'::regclass,
          'duplicate_model_ignores'::regclass
        )
      ORDER BY table_name
    `);

    expect(rows).toEqual([
      {
        table_name: 'duplicate_file_ignores',
        definition: 'PRIMARY KEY (library_id, hash)',
      },
      {
        table_name: 'duplicate_model_ignores',
        definition: 'PRIMARY KEY (library_id, fingerprint)',
      },
    ]);
  });

  it('cascades both ignore tables when their library is deleted', async () => {
    const { rows } = await pool.query<{ table_name: string; delete_action: string }>(`
      SELECT tc.table_name, rc.delete_rule AS delete_action
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_schema = tc.constraint_schema
       AND rc.constraint_name = tc.constraint_name
      WHERE tc.constraint_schema = 'public'
        AND tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name IN ('duplicate_file_ignores', 'duplicate_model_ignores')
      ORDER BY tc.table_name
    `);

    expect(rows).toEqual([
      { table_name: 'duplicate_file_ignores', delete_action: 'CASCADE' },
      { table_name: 'duplicate_model_ignores', delete_action: 'CASCADE' },
    ]);
  });
});
