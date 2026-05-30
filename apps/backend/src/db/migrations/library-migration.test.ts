import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Gold-standard migration test for the library migration sequence (0005-0007).
//
// This proves the hand-written SQL migrations are correct ON A POPULATED
// database — the exact dangerous scenario they run in on production boot:
//   - 0005 creates the libraries table
//   - 0006 backfills exactly one default library per existing user (idempotent)
//   - 0007 adds library_id to models/collections, backfills from the owning
//     user's default library, then flips both columns to NOT NULL
//
// Strategy: spin up a throwaway scratch database, apply migrations 0000-0004 to
// build the pre-library base schema, insert fixtures that simulate pre-existing
// production rows (users + models + collections with NO library_id), then apply
// 0005/0006/0007 in sequence and assert the data + constraints + indexes.
//
// CREATE/DROP DATABASE cannot run inside a transaction and cannot run against
// the database you are connected to, so we use a separate pool to the
// maintenance DB to create/drop the scratch DB.
// ---------------------------------------------------------------------------

const MAINTENANCE_URL = 'postgresql://alexandria:alexandria@localhost:5433/alexandria_test';
const SCRATCH_DB = 'lib_mig_test_scratch';
const SCRATCH_URL = `postgresql://alexandria:alexandria@localhost:5433/${SCRATCH_DB}`;

const MIGRATIONS_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Read a migration file and split it into individual statements. */
function readStatements(tag: string): string[] {
  const sql = readFileSync(`${MIGRATIONS_DIR}${tag}.sql`, 'utf8');
  return sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Apply every statement in a migration file, in order, on the given pool. */
async function applyMigration(pool: pg.Pool, tag: string): Promise<void> {
  for (const stmt of readStatements(tag)) {
    await pool.query(stmt);
  }
}

let maintenancePool: pg.Pool;
let scratch: pg.Pool;

const userIds: string[] = [];
const userModelIds: Record<string, string[]> = {};
const userCollectionIds: Record<string, string[]> = {};

beforeAll(async () => {
  maintenancePool = new Pool({ connectionString: MAINTENANCE_URL });

  // Robust to a previous failed run: terminate connections then drop+create.
  await maintenancePool.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [SCRATCH_DB],
  );
  await maintenancePool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
  await maintenancePool.query(`CREATE DATABASE "${SCRATCH_DB}"`);

  scratch = new Pool({ connectionString: SCRATCH_URL });

  // pgcrypto provides gen_random_uuid() on older PG; on PG13+ it is built in.
  // CREATE EXTENSION IF NOT EXISTS is a no-op when already available.
  await scratch.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  // --- Base schema: everything BEFORE libraries existed. ---
  await applyMigration(scratch, '0000_old_gabe_jones');
  await applyMigration(scratch, '0001_add_models_fts');
  await applyMigration(scratch, '0002_add_preview_image_file_id');
  await applyMigration(scratch, '0003_add_preview_crop');
  await applyMigration(scratch, '0004_add_preview_crop_scale');

  // --- Fixtures: simulate pre-existing production data (no library_id). ---
  // 2 users, each owning several models and a couple of collections.
  for (let u = 0; u < 2; u++) {
    const { rows } = await scratch.query(
      `INSERT INTO "users" ("email", "display_name", "password_hash", "role")
       VALUES ($1, $2, 'not-a-real-hash', 'admin') RETURNING "id"`,
      [`mig-user-${u}@example.com`, `Migration User ${u}`],
    );
    const userId = rows[0].id as string;
    userIds.push(userId);
    userModelIds[userId] = [];
    userCollectionIds[userId] = [];

    // 3 models per user.
    for (let m = 0; m < 3; m++) {
      const { rows: mr } = await scratch.query(
        `INSERT INTO "models" ("name", "slug", "user_id", "source_type", "status", "total_size_bytes", "file_count")
         VALUES ($1, $2, $3, 'zip_upload', 'ready', 1000, 1) RETURNING "id"`,
        [`Model ${u}-${m}`, `model-${u}-${m}`, userId],
      );
      userModelIds[userId].push(mr[0].id as string);
    }

    // 2 collections per user.
    for (let c = 0; c < 2; c++) {
      const { rows: cr } = await scratch.query(
        `INSERT INTO "collections" ("name", "slug", "user_id")
         VALUES ($1, $2, $3) RETURNING "id"`,
        [`Collection ${u}-${c}`, `collection-${u}-${c}`, userId],
      );
      userCollectionIds[userId].push(cr[0].id as string);
    }
  }

  // --- Apply the library migration sequence in strict order. ---
  await applyMigration(scratch, '0005_add_libraries');
  await applyMigration(scratch, '0006_backfill_default_libraries');
  // Re-apply 0006 to prove idempotency BEFORE 0007 depends on it.
  await applyMigration(scratch, '0006_backfill_default_libraries');
  await applyMigration(scratch, '0007_add_library_id');
}, 60_000);

afterAll(async () => {
  if (scratch) await scratch.end();
  if (maintenancePool) {
    await maintenancePool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [SCRATCH_DB],
    );
    await maintenancePool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
    await maintenancePool.end();
  }
});

describe('library migration sequence (0005-0007) on a populated database', () => {
  it('0006 creates exactly one default library per user (idempotent across two applies)', async () => {
    const { rows } = await scratch.query(
      `SELECT "user_id", count(*)::int AS n FROM "libraries"
       WHERE "is_default" = true GROUP BY "user_id"`,
    );
    // Exactly 2 default libraries total — one per user — despite 0006 running twice.
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.n).toBe(1);
    }

    const { rows: total } = await scratch.query(`SELECT count(*)::int AS n FROM "libraries"`);
    expect(total[0].n).toBe(2);
  });

  it('every model and collection has a non-null library_id after backfill', async () => {
    const { rows: m } = await scratch.query(
      `SELECT count(*)::int AS n FROM "models" WHERE "library_id" IS NULL`,
    );
    expect(m[0].n).toBe(0);

    const { rows: c } = await scratch.query(
      `SELECT count(*)::int AS n FROM "collections" WHERE "library_id" IS NULL`,
    );
    expect(c[0].n).toBe(0);
  });

  it("every model's library_id equals its owner's default library id", async () => {
    const { rows } = await scratch.query(
      `SELECT m."id", m."library_id", l."id" AS expected
       FROM "models" m
       JOIN "libraries" l ON l."user_id" = m."user_id" AND l."is_default" = true`,
    );
    expect(rows.length).toBe(6); // 2 users * 3 models
    for (const r of rows) {
      expect(r.library_id).toBe(r.expected);
    }
  });

  it("every collection's library_id equals its owner's default library id", async () => {
    const { rows } = await scratch.query(
      `SELECT c."id", c."library_id", l."id" AS expected
       FROM "collections" c
       JOIN "libraries" l ON l."user_id" = c."user_id" AND l."is_default" = true`,
    );
    expect(rows.length).toBe(4); // 2 users * 2 collections
    for (const r of rows) {
      expect(r.library_id).toBe(r.expected);
    }
  });

  it('library_id is NOT NULL on both models and collections', async () => {
    const { rows } = await scratch.query(
      `SELECT table_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'library_id'
         AND table_name IN ('models', 'collections')
       ORDER BY table_name`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.is_nullable).toBe('NO');
    }
  });

  it('the expected indexes exist', async () => {
    const { rows } = await scratch.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('models_library_id_idx', 'collections_library_id_idx', 'libraries_user_id_idx')`,
    );
    const names = rows.map((r) => r.indexname).sort();
    expect(names).toEqual([
      'collections_library_id_idx',
      'libraries_user_id_idx',
      'models_library_id_idx',
    ]);
  });

  it('the library_id foreign keys to libraries exist', async () => {
    const { rows } = await scratch.query(
      `SELECT conname FROM pg_constraint
       WHERE contype = 'f'
         AND conname IN ('models_library_id_libraries_id_fk', 'collections_library_id_libraries_id_fk')`,
    );
    const names = rows.map((r) => r.conname).sort();
    expect(names).toEqual([
      'collections_library_id_libraries_id_fk',
      'models_library_id_libraries_id_fk',
    ]);
  });
});
