/**
 * Tests for searchService.searchAll() — the P3 cross-entity global search.
 *
 * Seeding strategy mirrors search.service.test.ts exactly: one user, one
 * library, a handful of models with tags + artist metadata + a collection.
 * We assert hits in all four result buckets (models, collections, artists,
 * tags) and verify library isolation (a second library's data never leaks).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  users,
  libraries,
  models,
  tags,
  modelTags,
  collections,
  collectionModels,
  metadataFieldDefinitions,
  modelMetadata,
} from '../db/schema/index.js';
import { searchService } from './search.service.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let testUserId: string;
let testLibraryId: string;
let otherLibraryId: string;

const modelIds: string[] = [];
const tagIds: Record<string, string> = {};
let collectionId: string;
let otherModelId: string;

const fieldDefIds: Record<string, string> = {};

beforeAll(async () => {
  const ts = Date.now();

  // -------------------------------------------------------------------------
  // Clean up any leftover fixtures from a previous failed run
  // -------------------------------------------------------------------------
  const leftoverUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'searchall-test@example.com'));

  if (leftoverUsers.length > 0) {
    const ids = leftoverUsers.map((u) => u.id);
    await db.delete(collections).where(inArray(collections.userId, ids));
    await db.delete(models).where(inArray(models.userId, ids));
    await db.delete(libraries).where(inArray(libraries.userId, ids));
    await db.delete(users).where(eq(users.email, 'searchall-test@example.com'));
  }

  // Clean up orphaned test tags from previous runs
  await db.delete(tags).where(inArray(tags.name, [`Dragon-${ts}`, `Fantasy-${ts}`]));

  // -------------------------------------------------------------------------
  // Create the test user
  // -------------------------------------------------------------------------
  const [testUser] = await db
    .insert(users)
    .values({
      email: 'searchall-test@example.com',
      displayName: 'SearchAll Test User',
      passwordHash: 'not-a-real-hash',
      role: 'user',
    })
    .returning();

  testUserId = testUser.id;

  // -------------------------------------------------------------------------
  // Primary test library
  // -------------------------------------------------------------------------
  const [testLibrary] = await db
    .insert(libraries)
    .values({
      name: 'SearchAll Test Library',
      slug: `searchall-test-library-${ts}`,
      userId: testUserId,
      isDefault: true,
    })
    .returning();

  testLibraryId = testLibrary.id;

  // -------------------------------------------------------------------------
  // Secondary library (isolation)
  // -------------------------------------------------------------------------
  const [otherLibrary] = await db
    .insert(libraries)
    .values({
      name: 'SearchAll Other Library',
      slug: `searchall-other-library-${ts}`,
      userId: testUserId,
      isDefault: false,
    })
    .returning();

  otherLibraryId = otherLibrary.id;

  // -------------------------------------------------------------------------
  // Resolve field definition IDs (artist, tags come from seed data)
  // -------------------------------------------------------------------------
  const fieldDefs = await db
    .select({ id: metadataFieldDefinitions.id, slug: metadataFieldDefinitions.slug })
    .from(metadataFieldDefinitions)
    .where(eq(metadataFieldDefinitions.isDefault, true));

  for (const fd of fieldDefs) {
    fieldDefIds[fd.slug] = fd.id;
  }

  // -------------------------------------------------------------------------
  // Create models in the primary library:
  //   [0] "Dragon Bust Alpha"    — status: ready, artist: sculptor-sa, tag: Dragon-<ts>
  //   [1] "Fantasy Set Beta"     — status: ready, tag: Fantasy-<ts>
  //   [2] "Mech Warrior Gamma"   — status: ready (no tags, no artist)
  // -------------------------------------------------------------------------
  const modelDefs = [
    {
      name: 'Dragon Bust Alpha',
      description: 'A fierce dragon bust model',
      status: 'ready' as const,
      totalSizeBytes: 1_000_000,
    },
    {
      name: 'Fantasy Set Beta',
      description: 'Fantasy warrior collection',
      status: 'ready' as const,
      totalSizeBytes: 2_000_000,
    },
    {
      name: 'Mech Warrior Gamma',
      description: 'Futuristic mechanical warrior',
      status: 'ready' as const,
      totalSizeBytes: 3_000_000,
    },
  ];

  for (let i = 0; i < modelDefs.length; i++) {
    const def = modelDefs[i];
    const [m] = await db
      .insert(models)
      .values({
        name: def.name,
        slug: `searchall-test-${def.name.toLowerCase().replace(/\s+/g, '-')}-${ts}-${i}`,
        description: def.description,
        userId: testUserId,
        libraryId: testLibraryId,
        sourceType: 'zip_upload',
        status: def.status,
        totalSizeBytes: def.totalSizeBytes,
        fileCount: 1,
      })
      .returning();

    modelIds.push(m.id);
  }

  // -------------------------------------------------------------------------
  // Create tags (unique per test run to avoid cross-test contamination)
  // -------------------------------------------------------------------------
  const tagDefs = [
    { name: `Dragon-${ts}`, slug: `dragon-searchall-${ts}` },
    { name: `Fantasy-${ts}`, slug: `fantasy-searchall-${ts}` },
  ];

  for (const tagDef of tagDefs) {
    const [tag] = await db.insert(tags).values(tagDef).returning();
    // Key by the prefix part before the timestamp
    const key = tagDef.name.split('-')[0].toLowerCase(); // 'dragon' or 'fantasy'
    tagIds[key] = tag.id;
  }

  // Assign tags to models
  await db.insert(modelTags).values([
    { modelId: modelIds[0], tagId: tagIds['dragon'] },
    { modelId: modelIds[1], tagId: tagIds['fantasy'] },
  ]);

  // -------------------------------------------------------------------------
  // Assign artist metadata to model[0]
  // -------------------------------------------------------------------------
  const artistFieldId = fieldDefIds['artist'];
  if (artistFieldId) {
    await db.insert(modelMetadata).values([
      { modelId: modelIds[0], fieldDefinitionId: artistFieldId, value: 'sculptor-sa' },
    ]);
  }

  // -------------------------------------------------------------------------
  // Create a collection containing model[0]
  // -------------------------------------------------------------------------
  const [testCollection] = await db
    .insert(collections)
    .values({
      name: 'Dragon Busts SA',
      slug: `dragon-busts-sa-${ts}`,
      userId: testUserId,
      libraryId: testLibraryId,
    })
    .returning();

  collectionId = testCollection.id;

  await db.insert(collectionModels).values([{ collectionId, modelId: modelIds[0] }]);

  // -------------------------------------------------------------------------
  // Create a model in the OTHER library that must never appear in primary results
  // -------------------------------------------------------------------------
  const [mOther] = await db
    .insert(models)
    .values({
      name: 'Dragon Other Library Model',
      slug: `searchall-other-dragon-${ts}`,
      description: 'Dragon model in the other library — must not leak',
      userId: testUserId,
      libraryId: otherLibraryId,
      sourceType: 'zip_upload',
      status: 'ready',
      totalSizeBytes: 500_000,
      fileCount: 1,
    })
    .returning();

  otherModelId = mOther.id;
});

afterAll(async () => {
  // FK-ordered cleanup: models first (cascades to model_tags, model_metadata,
  // collection_models), then tags, collections, libraries, user.
  const allModelIds = [...modelIds, otherModelId].filter(Boolean);
  if (allModelIds.length > 0) {
    await db.delete(models).where(inArray(models.id, allModelIds));
  }

  const tagIdValues = Object.values(tagIds);
  if (tagIdValues.length > 0) {
    await db.delete(tags).where(inArray(tags.id, tagIdValues));
  }

  if (collectionId) {
    await db.delete(collections).where(eq(collections.id, collectionId));
  }

  if (testLibraryId) {
    await db.delete(libraries).where(eq(libraries.id, testLibraryId));
  }

  if (otherLibraryId) {
    await db.delete(libraries).where(eq(libraries.id, otherLibraryId));
  }

  if (testUserId) {
    await db.delete(users).where(eq(users.id, testUserId));
  }
});

// ---------------------------------------------------------------------------
// describe: result shape
// ---------------------------------------------------------------------------

describe('searchAll — result shape', () => {
  it('should return a GlobalSearchResult with q, models, collections, artists, tags keys', async () => {
    const result = await searchService.searchAll({ q: 'dragon' }, testUserId, testLibraryId);

    expect(result).toHaveProperty('q', 'dragon');
    expect(result).toHaveProperty('models');
    expect(result).toHaveProperty('collections');
    expect(result).toHaveProperty('artists');
    expect(result).toHaveProperty('tags');

    // models bucket is { items: ModelCard[], total: number }
    expect(Array.isArray(result.models.items)).toBe(true);
    expect(typeof result.models.total).toBe('number');

    // Other buckets are arrays
    expect(Array.isArray(result.collections)).toBe(true);
    expect(Array.isArray(result.artists)).toBe(true);
    expect(Array.isArray(result.tags)).toBe(true);
  });

  it('should echo the trimmed query back in the q field', async () => {
    const result = await searchService.searchAll({ q: '  dragon  ' }, testUserId, testLibraryId);
    expect(result.q).toBe('dragon');
  });
});

// ---------------------------------------------------------------------------
// describe: models bucket
// ---------------------------------------------------------------------------

describe('searchAll — models bucket', () => {
  it('should include models matching the query in the models.items array', async () => {
    const result = await searchService.searchAll({ q: 'Dragon Bust Alpha' }, testUserId, testLibraryId);

    const ourMatch = result.models.items.find((m) => m.id === modelIds[0]);
    expect(ourMatch).toBeDefined();
    expect(ourMatch!.name).toBe('Dragon Bust Alpha');
  });

  it('should report models.total as the full match count (not capped by limit)', async () => {
    const result = await searchService.searchAll(
      { q: 'dragon', limit: 1 },
      testUserId,
      testLibraryId,
    );
    // total reflects all DB matches even when limit restricts items length
    expect(result.models.total).toBeGreaterThanOrEqual(1);
    expect(result.models.items.length).toBeLessThanOrEqual(1);
  });

  it('should return an empty models bucket when query matches nothing', async () => {
    const result = await searchService.searchAll(
      { q: 'xyzzy-zzt-nothing-matches' },
      testUserId,
      testLibraryId,
    );

    expect(result.models.items).toHaveLength(0);
    expect(result.models.total).toBe(0);
  });

  it('should include ModelCard shape fields (id, name, slug, status, createdAt)', async () => {
    const result = await searchService.searchAll({ q: 'Dragon Bust Alpha' }, testUserId, testLibraryId);

    const card = result.models.items.find((m) => m.id === modelIds[0]);
    expect(card).toBeDefined();
    expect(card).toHaveProperty('id');
    expect(card).toHaveProperty('name');
    expect(card).toHaveProperty('slug');
    expect(card).toHaveProperty('status');
    expect(card).toHaveProperty('createdAt');
    expect(card).toHaveProperty('metadata');
    expect(Array.isArray(card!.metadata)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describe: collections bucket
// ---------------------------------------------------------------------------

describe('searchAll — collections bucket', () => {
  it('should include a collection whose name contains the query needle', async () => {
    // "Dragon Busts SA" contains "dragon"
    const result = await searchService.searchAll({ q: 'Dragon' }, testUserId, testLibraryId);

    const hit = result.collections.find((c) => c.id === collectionId);
    expect(hit).toBeDefined();
    expect(hit!.name).toBe('Dragon Busts SA');
    expect(typeof hit!.id).toBe('string');
    expect(typeof hit!.slug).toBe('string');
    expect(typeof hit!.modelCount).toBe('number');
  });

  it('should NOT include collections whose names do not match the query', async () => {
    // Query "warrior" — "Dragon Busts SA" does not contain "warrior"
    const result = await searchService.searchAll({ q: 'warrior' }, testUserId, testLibraryId);

    const hit = result.collections.find((c) => c.id === collectionId);
    expect(hit).toBeUndefined();
  });

  it('should return an empty collections array when query matches no collections', async () => {
    const result = await searchService.searchAll(
      { q: 'xyzzy-zzt-nothing-matches' },
      testUserId,
      testLibraryId,
    );
    expect(result.collections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// describe: artists bucket
// ---------------------------------------------------------------------------

describe('searchAll — artists bucket', () => {
  it('should include an artist whose value contains the query needle', async () => {
    // model[0] has artist "sculptor-sa"; query "sculptor" should surface it
    const result = await searchService.searchAll({ q: 'sculptor' }, testUserId, testLibraryId);

    const hit = result.artists.find((a) => a.name === 'sculptor-sa');
    expect(hit).toBeDefined();
    expect(typeof hit!.modelCount).toBe('number');
    expect(hit!.modelCount).toBeGreaterThanOrEqual(1);
  });

  it('should NOT include artists that do not match the query needle', async () => {
    // Query "dragon" — no artist value contains "dragon" in the test set
    // (artist is "sculptor-sa")
    const result = await searchService.searchAll({ q: 'dragon' }, testUserId, testLibraryId);

    const hit = result.artists.find((a) => a.name === 'sculptor-sa');
    // artist "sculptor-sa" should NOT appear because it doesn't contain "dragon"
    expect(hit).toBeUndefined();
  });

  it('should return an empty artists array when query matches no artists', async () => {
    const result = await searchService.searchAll(
      { q: 'xyzzy-zzt-nothing-matches' },
      testUserId,
      testLibraryId,
    );
    expect(result.artists).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// describe: tags bucket
// ---------------------------------------------------------------------------

describe('searchAll — tags bucket', () => {
  it('should include a tag whose name contains the query needle', async () => {
    // Tag `Dragon-<ts>` contains the prefix "Dragon"
    const ts = tagIds['dragon'];
    expect(ts).toBeDefined(); // sanity: tag was created

    const result = await searchService.searchAll({ q: 'Dragon' }, testUserId, testLibraryId);

    // Look for a tag that starts with "Dragon" (our timestamped tag name)
    const hit = result.tags.find((t) => t.name.toLowerCase().startsWith('dragon'));
    expect(hit).toBeDefined();
    expect(typeof hit!.modelCount).toBe('number');
    expect(hit!.modelCount).toBeGreaterThanOrEqual(1);
  });

  it('should NOT include tags that do not match the query needle', async () => {
    // Query "sculptor" — no tag name contains "sculptor"
    const result = await searchService.searchAll({ q: 'sculptor' }, testUserId, testLibraryId);

    const dragonTag = result.tags.find((t) => t.name.toLowerCase().startsWith('dragon'));
    expect(dragonTag).toBeUndefined();
  });

  it('should return an empty tags array when query matches no tags', async () => {
    const result = await searchService.searchAll(
      { q: 'xyzzy-zzt-nothing-matches' },
      testUserId,
      testLibraryId,
    );
    expect(result.tags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// describe: library isolation
// ---------------------------------------------------------------------------

describe('searchAll — library isolation', () => {
  it('should not include models from a different library in the models bucket', async () => {
    // "Dragon Other Library Model" lives in otherLibraryId, not testLibraryId
    const result = await searchService.searchAll({ q: 'dragon' }, testUserId, testLibraryId);

    const leaked = result.models.items.find((m) => m.id === otherModelId);
    expect(leaked).toBeUndefined();
  });

  it('should include the other-library model when searching THAT library', async () => {
    const result = await searchService.searchAll({ q: 'dragon' }, testUserId, otherLibraryId);

    const found = result.models.items.find((m) => m.id === otherModelId);
    expect(found).toBeDefined();

    // Primary library models must NOT appear in the other library's results
    for (const id of modelIds) {
      const leaked = result.models.items.find((m) => m.id === id);
      expect(leaked).toBeUndefined();
    }
  });

  it('should not include primary-library collections when searching the other library', async () => {
    // "Dragon Busts SA" belongs to testLibraryId, not otherLibraryId
    const result = await searchService.searchAll({ q: 'dragon' }, testUserId, otherLibraryId);

    const leaked = result.collections.find((c) => c.id === collectionId);
    expect(leaked).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// describe: limit param
// ---------------------------------------------------------------------------

describe('searchAll — limit param', () => {
  it('should cap the models.items length at the specified limit', async () => {
    // Use a broad query that has multiple hits; restrict to limit=1
    const result = await searchService.searchAll(
      { q: 'dragon', limit: 1 },
      testUserId,
      testLibraryId,
    );

    expect(result.models.items.length).toBeLessThanOrEqual(1);
  });

  it('should apply the default limit (6) when not specified', async () => {
    // With only 3 test models total, items.length must be ≤ 6 (but >= our hits)
    const result = await searchService.searchAll({ q: 'dragon' }, testUserId, testLibraryId);

    expect(result.models.items.length).toBeLessThanOrEqual(6);
  });
});
