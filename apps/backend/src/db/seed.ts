import argon2 from 'argon2';
import { db, pool } from './index.js';
import { users } from './schema/user.js';
import { metadataFieldDefinitions } from './schema/metadata.js';

// Default admin credentials — override via environment variables
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@alexandria.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'changeme';
const ADMIN_DISPLAY_NAME = process.env.SEED_ADMIN_DISPLAY_NAME || 'Admin';

// Default metadata field definitions seeded on first run.
// These fields have isDefault: true and cannot be deleted via the API.
// Tags uses optimized storage (model_tags join table) but its definition lives here.
// sortOrder controls UI display order.
const DEFAULT_FIELDS = [
  {
    name: 'Tags',
    slug: 'tags',
    type: 'multi_enum' as const,
    isDefault: true,
    isFilterable: true,
    isBrowsable: true,
    config: null,
    sortOrder: 0,
  },
  {
    name: 'Artist',
    slug: 'artist',
    type: 'text' as const,
    isDefault: true,
    isFilterable: true,
    isBrowsable: true,
    config: null,
    sortOrder: 1,
  },
  {
    name: 'Year',
    slug: 'year',
    type: 'number' as const,
    isDefault: true,
    isFilterable: true,
    isBrowsable: false,
    config: null,
    sortOrder: 2,
  },
  {
    name: 'NSFW',
    slug: 'nsfw',
    type: 'boolean' as const,
    isDefault: true,
    isFilterable: true,
    isBrowsable: false,
    config: null,
    sortOrder: 3,
  },
  {
    name: 'URL',
    slug: 'url',
    type: 'url' as const,
    isDefault: true,
    isFilterable: false,
    isBrowsable: false,
    config: null,
    sortOrder: 4,
  },
  {
    name: 'Pre-supported',
    slug: 'pre-supported',
    type: 'boolean' as const,
    isDefault: true,
    isFilterable: true,
    isBrowsable: false,
    config: null,
    sortOrder: 5,
  },
] as const;

async function seed() {
  console.log('Seeding database...');

  // --- Admin user ---
  const passwordHash = await argon2.hash(ADMIN_PASSWORD);

  await db
    .insert(users)
    .values({
      email: ADMIN_EMAIL,
      displayName: ADMIN_DISPLAY_NAME,
      passwordHash,
      role: 'admin',
    })
    .onConflictDoNothing({ target: users.email });

  console.log(`Admin user ready: ${ADMIN_EMAIL}`);

  // --- Default metadata field definitions ---
  // Insert all default fields; skip any that already exist (idempotent by slug unique constraint)
  for (const field of DEFAULT_FIELDS) {
    await db
      .insert(metadataFieldDefinitions)
      .values(field)
      .onConflictDoNothing({ target: metadataFieldDefinitions.slug });
  }

  console.log(`Default metadata fields ready: ${DEFAULT_FIELDS.map((f) => f.name).join(', ')}`);

  console.log('Seed complete.');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
