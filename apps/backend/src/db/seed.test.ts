import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import { db } from './index.js';
import { users } from './schema/user.js';
import { libraries } from './schema/library.js';
import { metadataFieldDefinitions } from './schema/metadata.js';
import { runSeed } from './seed.js';

// ---------------------------------------------------------------------------
// Seed idempotency test — default library for the admin user
//
// Runs against the test database (DATABASE_URL set by vitest.config.ts).
// The test database is already migrated and seeded once by the test harness
// before this file runs; we run the seed a second time and assert that the
// admin user still ends up with exactly one default library.
//
// Strategy:
//   1. In beforeAll, capture the admin user's id from the DB (the first seed
//      has already run as part of harness setup).
//   2. Run runSeed() again (second call).
//   3. Assert count of libraries WHERE user_id = admin AND is_default = true === 1.
//
// We do NOT delete the admin user or seeded field definitions — other test
// files depend on those rows. We only assert, never destroy shared fixtures.
// ---------------------------------------------------------------------------

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@alexandria.local';

let adminUserId: string;

beforeAll(async () => {
  // Run the seed twice in sequence. Whether the admin user + library already
  // exist (from prior DB state) or not, both calls must converge to exactly one
  // default library for the admin. This is the core idempotency invariant.
  await runSeed();
  await runSeed();

  // Fetch the admin user's id after seed so the assertions below can scope the
  // library count query to the correct user.
  const [adminUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL))
    .limit(1);

  if (!adminUser) {
    throw new Error(
      `Admin user not found (${ADMIN_EMAIL}) after running runSeed() twice. ` +
        'The seed should have created it.',
    );
  }

  adminUserId = adminUser.id;
});

afterAll(async () => {
  // Nothing to clean up: the admin user and their default library are part of
  // the shared seed baseline. Other test files rely on the seeded metadata
  // field definitions and admin user; deleting them here would cause flaky
  // failures depending on test file execution order.
});

// ---------------------------------------------------------------------------
// Idempotency assertions
// ---------------------------------------------------------------------------

describe('runSeed() — admin default library idempotency', () => {
  it('the admin user has exactly one default library after running the seed twice', async () => {
    const [{ value }] = await db
      .select({ value: count() })
      .from(libraries)
      .where(and(eq(libraries.userId, adminUserId), eq(libraries.isDefault, true)));

    expect(value).toBe(1);
  });

  it('the admin default library has the expected name and slug derived from the admin id', async () => {
    const ADMIN_DISPLAY_NAME = process.env.SEED_ADMIN_DISPLAY_NAME || 'Admin';

    const [lib] = await db
      .select({ name: libraries.name, slug: libraries.slug })
      .from(libraries)
      .where(and(eq(libraries.userId, adminUserId), eq(libraries.isDefault, true)))
      .limit(1);

    expect(lib).toBeDefined();
    expect(lib.name).toBe(`${ADMIN_DISPLAY_NAME}'s Library`);
    expect(lib.slug).toBe(`library-${adminUserId.replace(/-/g, '')}`);
  });
});

describe('runSeed() — Source metadata field idempotency', () => {
  it('creates and retains exactly one default Source definition after running twice', async () => {
    const rows = await db
      .select({
        name: metadataFieldDefinitions.name,
        type: metadataFieldDefinitions.type,
        isDefault: metadataFieldDefinitions.isDefault,
        isFilterable: metadataFieldDefinitions.isFilterable,
        isBrowsable: metadataFieldDefinitions.isBrowsable,
      })
      .from(metadataFieldDefinitions)
      .where(eq(metadataFieldDefinitions.slug, 'source'));

    expect(rows).toEqual([
      {
        name: 'Source',
        type: 'text',
        isDefault: true,
        isFilterable: true,
        isBrowsable: true,
      },
    ]);
  });
});
