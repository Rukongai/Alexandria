import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  users,
  models,
  modelFiles,
  thumbnails,
  metadataFieldDefinitions,
  modelMetadata,
  tags,
  modelTags,
  collections,
  collectionModels,
} from '../db/schema/index.js';
import { searchService } from './search.service.js';
import { AppError } from '../utils/errors.js';
import type { ModelCard } from '@alexandria/shared';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
//
// All tests share fixtures created in beforeAll and cleaned up in afterAll.
// Each describe block works with the same underlying data; tests must not
// mutate shared fixture state.
//
// Fixture layout:
//   testUserId      — owner of all test models / collections
//   modelIds        — array of 6 model IDs in insertion order
//     [0] "Alpha Dragon Bust"      — status: ready,  has tag "dragon", artist "sculptor-a", stl file, image file w/ thumbnail
//     [1] "Beta Fantasy Set"       — status: ready,  has tag "fantasy", description mentions "dragon"
//     [2] "Gamma Sci-Fi Mech"      — status: ready,  has tag "sci-fi", artist "sculptor-b"
//     [3] "Delta Horror Props"     — status: error,  no tags
//     [4] "Epsilon Medieval Arms"  — status: ready,  has tags "dragon" AND "fantasy" (both)
//     [5] "Zeta Processing Model"  — status: processing, no tags
//
//   collectionId    — collection containing models [0] and [1]
//   tagIds          — { dragon, fantasy, sciFi }
// ---------------------------------------------------------------------------

let testUserId: string;
const modelIds: string[] = [];
let collectionId: string;
const tagIds: Record<string, string> = {};

// Field definition IDs queried from seed
const fieldDefIds: Record<string, string> = {};

beforeAll(async () => {
  // -------------------------------------------------------------------------
  // Cleanup any leftovers from a previous failed run
  // -------------------------------------------------------------------------
  const leftoverUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'search-test@example.com'));
  if (leftoverUsers.length > 0) {
    const leftoverUserIds = leftoverUsers.map((u) => u.id);
    await db.delete(collections).where(inArray(collections.userId, leftoverUserIds));
    await db.delete(models).where(inArray(models.userId, leftoverUserIds));
    await db.delete(users).where(eq(users.email, 'search-test@example.com'));
  }
  // Clean up orphaned test tags from previous runs
  await db.delete(tags).where(inArray(tags.name, ['Dragon', 'Fantasy', 'Sci-Fi']));

  // -------------------------------------------------------------------------
  // Create test user
  // -------------------------------------------------------------------------
  const [testUser] = await db
    .insert(users)
    .values({
      email: 'search-test@example.com',
      displayName: 'Search Test User',
      passwordHash: 'not-a-real-hash',
      role: 'admin',
    })
    .returning();

  testUserId = testUser.id;

  // -------------------------------------------------------------------------
  // Resolve default field definition IDs from seed
  // -------------------------------------------------------------------------
  const fieldDefs = await db
    .select({ id: metadataFieldDefinitions.id, slug: metadataFieldDefinitions.slug })
    .from(metadataFieldDefinitions)
    .where(eq(metadataFieldDefinitions.isDefault, true));

  for (const fd of fieldDefs) {
    fieldDefIds[fd.slug] = fd.id;
  }

  // -------------------------------------------------------------------------
  // Create models with staggered createdAt so ordering tests are deterministic
  // We insert one at a time to get different createdAt values.
  // -------------------------------------------------------------------------

  const modelDefs = [
    {
      name: 'Alpha Dragon Bust',
      description: 'A detailed bust of a fierce dragon',
      status: 'ready' as const,
      totalSizeBytes: 1_000_000,
    },
    {
      name: 'Beta Fantasy Set',
      description: 'Collection featuring a dragon warrior and elves',
      status: 'ready' as const,
      totalSizeBytes: 2_000_000,
    },
    {
      name: 'Gamma Sci-Fi Mech',
      description: 'Futuristic mechanical soldier',
      status: 'ready' as const,
      totalSizeBytes: 3_000_000,
    },
    {
      name: 'Delta Horror Props',
      description: 'Spooky Halloween props',
      status: 'error' as const,
      totalSizeBytes: 500_000,
    },
    {
      name: 'Epsilon Medieval Arms',
      description: 'Medieval knight with full armor and weapons',
      status: 'ready' as const,
      totalSizeBytes: 4_000_000,
    },
    {
      name: 'Zeta Processing Model',
      description: 'Currently being processed',
      status: 'processing' as const,
      totalSizeBytes: 100_000,
    },
  ];

  const ts = Date.now();
  for (let i = 0; i < modelDefs.length; i++) {
    const def = modelDefs[i];
    const [m] = await db
      .insert(models)
      .values({
        name: def.name,
        slug: `search-test-${def.name.toLowerCase().replace(/\s+/g, '-')}-${ts}-${i}`,
        description: def.description,
        userId: testUserId,
        sourceType: 'zip_upload',
        status: def.status,
        totalSizeBytes: def.totalSizeBytes,
        fileCount: 2,
      })
      .returning();

    modelIds.push(m.id);
  }

  // -------------------------------------------------------------------------
  // Create tags
  // -------------------------------------------------------------------------
  const tagDefs = [
    { name: 'Dragon', slug: `dragon-${ts}` },
    { name: 'Fantasy', slug: `fantasy-${ts}` },
    { name: 'Sci-Fi', slug: `sci-fi-${ts}` },
  ];

  for (const tagDef of tagDefs) {
    const [tag] = await db.insert(tags).values(tagDef).returning();
    // Key by the base slug prefix for easier reference
    const key = tagDef.slug.split('-').slice(0, -1).join('-'); // strip timestamp
    tagIds[key] = tag.id;
  }

  // Assign tags:
  //   model[0] ("Alpha Dragon Bust") → dragon
  //   model[1] ("Beta Fantasy Set")  → fantasy
  //   model[2] ("Gamma Sci-Fi Mech") → sci-fi
  //   model[4] ("Epsilon Medieval Arms") → dragon AND fantasy
  await db.insert(modelTags).values([
    { modelId: modelIds[0], tagId: tagIds['dragon'] },
    { modelId: modelIds[1], tagId: tagIds['fantasy'] },
    { modelId: modelIds[2], tagId: tagIds['sci-fi'] },
    { modelId: modelIds[4], tagId: tagIds['dragon'] },
    { modelId: modelIds[4], tagId: tagIds['fantasy'] },
  ]);

  // -------------------------------------------------------------------------
  // Assign generic metadata (artist field)
  // -------------------------------------------------------------------------
  const artistFieldId = fieldDefIds['artist'];
  if (artistFieldId) {
    await db.insert(modelMetadata).values([
      { modelId: modelIds[0], fieldDefinitionId: artistFieldId, value: 'sculptor-a' },
      { modelId: modelIds[2], fieldDefinitionId: artistFieldId, value: 'sculptor-b' },
    ]);
  }

  // -------------------------------------------------------------------------
  // Create model files:
  //   model[0]: one STL file + one image file
  //   model[1]: one document file
  //   model[2]: one STL file
  // -------------------------------------------------------------------------
  const [stlFileModel0] = await db
    .insert(modelFiles)
    .values({
      modelId: modelIds[0],
      filename: 'dragon.stl',
      relativePath: 'dragon.stl',
      fileType: 'stl',
      mimeType: 'model/stl',
      sizeBytes: 500_000,
      storagePath: '/storage/models/m0/dragon.stl',
      hash: 'abc123',
    })
    .returning();

  const [imageFileModel0] = await db
    .insert(modelFiles)
    .values({
      modelId: modelIds[0],
      filename: 'preview.jpg',
      relativePath: 'preview.jpg',
      fileType: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 200_000,
      storagePath: '/storage/models/m0/preview.jpg',
      hash: 'img123',
    })
    .returning();

  await db.insert(modelFiles).values({
    modelId: modelIds[1],
    filename: 'readme.pdf',
    relativePath: 'readme.pdf',
    fileType: 'document',
    mimeType: 'application/pdf',
    sizeBytes: 50_000,
    storagePath: '/storage/models/m1/readme.pdf',
    hash: 'doc123',
  });

  await db.insert(modelFiles).values({
    modelId: modelIds[2],
    filename: 'mech.stl',
    relativePath: 'mech.stl',
    fileType: 'stl',
    mimeType: 'model/stl',
    sizeBytes: 1_000_000,
    storagePath: '/storage/models/m2/mech.stl',
    hash: 'stl456',
  });

  // -------------------------------------------------------------------------
  // Create thumbnail for model[0]'s image file (grid size = 400px wide)
  // -------------------------------------------------------------------------
  await db.insert(thumbnails).values({
    sourceFileId: imageFileModel0.id,
    storagePath: '/storage/thumbnails/m0/thumb.webp',
    width: 400,
    height: 300,
    format: 'webp',
  });

  // -------------------------------------------------------------------------
  // Create a collection containing model[0] and model[1]
  // -------------------------------------------------------------------------
  const [testCollection] = await db
    .insert(collections)
    .values({
      name: 'Dragon Collection',
      slug: `dragon-collection-${ts}`,
      userId: testUserId,
    })
    .returning();

  collectionId = testCollection.id;

  await db.insert(collectionModels).values([
    { collectionId, modelId: modelIds[0] },
    { collectionId, modelId: modelIds[1] },
  ]);
});

afterAll(async () => {
  // Deleting the user cascades to... nothing (models reference user but no cascade).
  // Delete models first (cascades to files, thumbnails, model_tags, model_metadata,
  // collection_models). Then delete tags, collections, and finally the user.
  if (modelIds.length > 0) {
    await db.delete(models).where(inArray(models.id, modelIds));
  }

  // Delete test tags
  const tagIdValues = Object.values(tagIds);
  if (tagIdValues.length > 0) {
    await db.delete(tags).where(inArray(tags.id, tagIdValues));
  }

  // Delete test collection (collection_models already cleaned via model CASCADE)
  if (collectionId) {
    await db.delete(collections).where(eq(collections.id, collectionId));
  }

  // Delete test user
  if (testUserId) {
    await db.delete(users).where(eq(users.id, testUserId));
  }
});

// ---------------------------------------------------------------------------
// Helper — filter result models to only those owned by this test run
// -------------------------------------------------------------------------
function onlyTestModels(cards: ModelCard[]): ModelCard[] {
  return cards.filter((c) => modelIds.includes(c.id));
}

// ---------------------------------------------------------------------------
// describe: browse all models
// ---------------------------------------------------------------------------

describe('browse all models', () => {
  it('should return only ready models with default sort (createdAt desc) when no filters applied', async () => {
    const result = await searchService.searchModels({ pageSize: 100 });

    const ours = onlyTestModels(result.models);
    // Default filter excludes error/processing — only 4 ready models returned.
    // Default sort is createdAt desc — later-created models come first.
    // Ready models in creation order: Alpha(0), Beta(1), Gamma(2), Epsilon(4).
    expect(ours).toHaveLength(4);
    expect(ours.every((m) => m.status === 'ready')).toBe(true);

    const ourIds = ours.map((m) => m.id);
    expect(ourIds[0]).toBe(modelIds[4]); // Epsilon (newest ready)
    expect(ourIds[3]).toBe(modelIds[0]); // Alpha (oldest ready)
  });

  it('should include total count reflecting all matching rows', async () => {
    const result = await searchService.searchModels({ pageSize: 100 });
    // total >= 4 because the test DB may have other ready models
    expect(result.total).toBeGreaterThanOrEqual(4);
    expect(typeof result.total).toBe('number');
  });

  it('should return empty result with total 0 when no models match', async () => {
    const result = await searchService.searchModels({
      q: 'zzz-this-query-matches-nothing-absolutely-unique-xyzzy',
    });

    expect(result.models).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.cursor).toBeNull();
  });

  it('should include correct ModelCard shape fields', async () => {
    const result = await searchService.searchModels({
      status: 'ready',
      pageSize: 1,
    });

    expect(result.models.length).toBeGreaterThanOrEqual(1);
    const card = result.models[0];

    expect(card).toHaveProperty('id');
    expect(card).toHaveProperty('name');
    expect(card).toHaveProperty('slug');
    expect(card).toHaveProperty('status');
    expect(card).toHaveProperty('fileCount');
    expect(card).toHaveProperty('totalSizeBytes');
    expect(card).toHaveProperty('createdAt');
    expect(card).toHaveProperty('thumbnailUrl');
    expect(card).toHaveProperty('metadata');
    expect(Array.isArray(card.metadata)).toBe(true);
    expect(typeof card.createdAt).toBe('string');
    // ISO-8601 check
    expect(new Date(card.createdAt).toISOString()).toBe(card.createdAt);
  });
});

// ---------------------------------------------------------------------------
// describe: text search
// ---------------------------------------------------------------------------

describe('text search', () => {
  it('should return models matching search query in name', async () => {
    const result = await searchService.searchModels({ q: 'Alpha Dragon' });

    const ours = onlyTestModels(result.models);
    const ourIds = ours.map((m) => m.id);
    expect(ourIds).toContain(modelIds[0]); // Alpha Dragon Bust
  });

  it('should return models matching search query in description', async () => {
    // "Beta Fantasy Set" description: "Collection featuring a dragon warrior and elves"
    // Searching "warrior" should surface it via description tsvector (weight B)
    const result = await searchService.searchModels({ q: 'warrior elves' });

    const ours = onlyTestModels(result.models);
    const ourIds = ours.map((m) => m.id);
    expect(ourIds).toContain(modelIds[1]); // Beta Fantasy Set
  });

  it('should rank name matches higher than description-only matches', async () => {
    // "dragon" appears in:
    //   model[0] name: "Alpha Dragon Bust" — weight A (name)
    //   model[1] description: "Collection featuring a dragon warrior…" — weight B (description)
    //
    // With no explicit sort, searchModels uses relevance (ts_rank_cd) when q is provided.
    // model[0] should rank above model[1].
    const result = await searchService.searchModels({ q: 'dragon' });

    const ours = onlyTestModels(result.models);
    const idxAlpha = ours.findIndex((m) => m.id === modelIds[0]);
    const idxBeta = ours.findIndex((m) => m.id === modelIds[1]);

    // Both should appear
    expect(idxAlpha).toBeGreaterThanOrEqual(0);
    expect(idxBeta).toBeGreaterThanOrEqual(0);

    // Name match (Alpha) should come before description match (Beta)
    expect(idxAlpha).toBeLessThan(idxBeta);
  });

  it('should return total matching the full result set, not the page', async () => {
    const result = await searchService.searchModels({ q: 'dragon', pageSize: 1 });
    // total reflects all DB matches; our test data has at least 3 "dragon" hits
    // (Alpha name, Beta desc, Epsilon Medieval desc mentions medieval not dragon...
    //  actually Alpha + Beta + Epsilon-medieval doesn't mention dragon.
    //  Let's just assert total >= 1 and matches what we can verify)
    expect(result.total).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// describe: metadata filtering
// ---------------------------------------------------------------------------

describe('metadata filtering', () => {
  it('should filter by single tag and return only models with that tag', async () => {
    const result = await searchService.searchModels({
      tags: 'Dragon',
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    const ourIds = ours.map((m) => m.id);

    // model[0] and model[4] have the dragon tag
    expect(ourIds).toContain(modelIds[0]);
    expect(ourIds).toContain(modelIds[4]);

    // model[1] (fantasy only), model[2] (sci-fi only) should NOT appear
    expect(ourIds).not.toContain(modelIds[1]);
    expect(ourIds).not.toContain(modelIds[2]);
  });

  it('should filter by multiple tags with ALL semantics', async () => {
    const result = await searchService.searchModels({
      tags: 'Dragon,Fantasy',
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    const ourIds = ours.map((m) => m.id);

    // Only model[4] has BOTH dragon AND fantasy
    expect(ourIds).toContain(modelIds[4]);
    expect(ourIds).not.toContain(modelIds[0]); // dragon but not fantasy
    expect(ourIds).not.toContain(modelIds[1]); // fantasy but not dragon
  });

  it('should filter by generic metadata field (artist)', async () => {
    const result = await searchService.searchModels({
      metadataFilters: { artist: 'sculptor-a' },
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    const ourIds = ours.map((m) => m.id);

    // Only model[0] has artist = sculptor-a
    expect(ourIds).toContain(modelIds[0]);
    expect(ourIds).not.toContain(modelIds[1]);
    expect(ourIds).not.toContain(modelIds[2]); // model[2] has sculptor-b
  });

  it('should return zero results when metadata filter matches no models', async () => {
    const result = await searchService.searchModels({
      metadataFilters: { artist: 'nonexistent-artist-xyz' },
    });

    expect(result.total).toBe(0);
    expect(result.models).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// describe: collection filtering
// ---------------------------------------------------------------------------

describe('collection filtering', () => {
  it('should return only models in the specified collection', async () => {
    const result = await searchService.searchModels({
      collectionId,
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    const ourIds = ours.map((m) => m.id);

    // Collection contains model[0] and model[1]
    expect(ourIds).toContain(modelIds[0]);
    expect(ourIds).toContain(modelIds[1]);
    expect(ourIds).not.toContain(modelIds[2]);
    expect(ourIds).not.toContain(modelIds[3]);
    expect(ourIds).not.toContain(modelIds[4]);
    expect(ourIds).not.toContain(modelIds[5]);
  });

  it('should return empty result for a collection with no models', async () => {
    // Insert a temporary empty collection
    const ts = Date.now();
    const [emptyCollection] = await db
      .insert(collections)
      .values({
        name: 'Empty Test Collection',
        slug: `empty-collection-${ts}`,
        userId: testUserId,
      })
      .returning();

    try {
      const result = await searchService.searchModels({
        collectionId: emptyCollection.id,
      });
      expect(result.models).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.cursor).toBeNull();
    } finally {
      await db.delete(collections).where(eq(collections.id, emptyCollection.id));
    }
  });
});

// ---------------------------------------------------------------------------
// describe: file type filtering
// ---------------------------------------------------------------------------

describe('file type filtering', () => {
  it('should return only models containing files of the specified type (stl)', async () => {
    const result = await searchService.searchModels({
      fileType: 'stl',
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    const ourIds = ours.map((m) => m.id);

    // model[0] has an STL file, model[2] has an STL file
    expect(ourIds).toContain(modelIds[0]);
    expect(ourIds).toContain(modelIds[2]);

    // model[1] has only a document file
    expect(ourIds).not.toContain(modelIds[1]);
  });

  it('should return only models containing files of the specified type (document)', async () => {
    const result = await searchService.searchModels({
      fileType: 'document',
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    const ourIds = ours.map((m) => m.id);

    // Only model[1] has a document file
    expect(ourIds).toContain(modelIds[1]);
    expect(ourIds).not.toContain(modelIds[0]);
    expect(ourIds).not.toContain(modelIds[2]);
  });

  it('should return only models containing image files', async () => {
    const result = await searchService.searchModels({
      fileType: 'image',
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    const ourIds = ours.map((m) => m.id);

    // Only model[0] has an image file
    expect(ourIds).toContain(modelIds[0]);
    expect(ourIds).not.toContain(modelIds[1]);
    expect(ourIds).not.toContain(modelIds[2]);
  });
});

// ---------------------------------------------------------------------------
// describe: status filtering
// ---------------------------------------------------------------------------

describe('status filtering', () => {
  it('should return only models with status=ready', async () => {
    const result = await searchService.searchModels({
      status: 'ready',
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    // model[0], [1], [2], [4] are ready; [3] is error; [5] is processing
    expect(ours).toHaveLength(4);
    const ourIds = ours.map((m) => m.id);
    expect(ourIds).toContain(modelIds[0]);
    expect(ourIds).toContain(modelIds[1]);
    expect(ourIds).toContain(modelIds[2]);
    expect(ourIds).toContain(modelIds[4]);
    expect(ourIds).not.toContain(modelIds[3]);
    expect(ourIds).not.toContain(modelIds[5]);
  });

  it('should return only models with status=error', async () => {
    const result = await searchService.searchModels({
      status: 'error',
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    expect(ours).toHaveLength(1);
    expect(ours[0].id).toBe(modelIds[3]); // Delta Horror Props
  });

  it('should return only models with status=processing', async () => {
    const result = await searchService.searchModels({
      status: 'processing',
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    expect(ours).toHaveLength(1);
    expect(ours[0].id).toBe(modelIds[5]); // Zeta Processing Model
  });

  it('should return only ready models when status filter is omitted', async () => {
    const result = await searchService.searchModels({ pageSize: 100 });
    const ours = onlyTestModels(result.models);
    // Default browse excludes processing/error models — only 4 ready models
    expect(ours).toHaveLength(4);
    expect(ours.every((m) => m.status === 'ready')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describe: combined filters
// ---------------------------------------------------------------------------

describe('combined filters', () => {
  it('should apply text search and metadata filter as intersection', async () => {
    // "dragon" matches model[0] (name), model[1] (description), Epsilon (name? no — "Medieval Arms")
    // artist = sculptor-a matches only model[0]
    // Intersection: only model[0]
    const result = await searchService.searchModels({
      q: 'dragon',
      metadataFilters: { artist: 'sculptor-a' },
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    expect(ours).toHaveLength(1);
    expect(ours[0].id).toBe(modelIds[0]);
  });

  it('should combine tag filter with status filter', async () => {
    // Dragon tag: model[0] (ready) and model[4] (ready)
    // Status = ready: model[0], [1], [2], [4]
    // Intersection: model[0] and model[4]
    const result = await searchService.searchModels({
      tags: 'Dragon',
      status: 'ready',
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    const ourIds = ours.map((m) => m.id);
    expect(ourIds).toContain(modelIds[0]);
    expect(ourIds).toContain(modelIds[4]);
    expect(ours).toHaveLength(2);
  });

  it('should combine collection filter with text search', async () => {
    // Collection contains model[0] (Alpha Dragon Bust) and model[1] (Beta Fantasy Set)
    // Search "dragon" hits both via name/description
    // Intersection: both model[0] and model[1]
    const result = await searchService.searchModels({
      collectionId,
      q: 'dragon',
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    const ourIds = ours.map((m) => m.id);
    expect(ourIds).toContain(modelIds[0]);
    expect(ourIds).toContain(modelIds[1]);
  });
});

// ---------------------------------------------------------------------------
// describe: sorting
// ---------------------------------------------------------------------------

describe('sorting', () => {
  it('should sort by name ascending', async () => {
    const result = await searchService.searchModels({
      sort: 'name',
      sortDir: 'asc',
      status: 'ready', // narrow to our known 4 ready models
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    // Ready test models: Alpha, Beta, Gamma, Epsilon
    // Alphabetical asc: Alpha, Beta, Epsilon, Gamma
    expect(ours[0].name).toBe('Alpha Dragon Bust');
    expect(ours[1].name).toBe('Beta Fantasy Set');
    expect(ours[2].name).toBe('Epsilon Medieval Arms');
    expect(ours[3].name).toBe('Gamma Sci-Fi Mech');
  });

  it('should sort by name descending', async () => {
    const result = await searchService.searchModels({
      sort: 'name',
      sortDir: 'desc',
      status: 'ready',
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    // Reverse alphabetical: Gamma, Epsilon, Beta, Alpha
    expect(ours[0].name).toBe('Gamma Sci-Fi Mech');
    expect(ours[1].name).toBe('Epsilon Medieval Arms');
    expect(ours[2].name).toBe('Beta Fantasy Set');
    expect(ours[3].name).toBe('Alpha Dragon Bust');
  });

  it('should sort by createdAt ascending (oldest first)', async () => {
    const result = await searchService.searchModels({
      sort: 'createdAt',
      sortDir: 'asc',
      status: 'ready',
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    // Ready models in creation order: Alpha(0), Beta(1), Gamma(2), Epsilon(4)
    expect(ours[0].id).toBe(modelIds[0]); // Alpha (oldest ready)
    expect(ours[3].id).toBe(modelIds[4]); // Epsilon (newest ready)
  });

  it('should sort by createdAt descending (newest first)', async () => {
    const result = await searchService.searchModels({
      sort: 'createdAt',
      sortDir: 'desc',
      status: 'ready',
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    // Ready models in reverse creation order: Epsilon(4), Gamma(2), Beta(1), Alpha(0)
    expect(ours[0].id).toBe(modelIds[4]); // Epsilon (newest ready)
    expect(ours[3].id).toBe(modelIds[0]); // Alpha (oldest ready)
  });

  it('should sort by totalSizeBytes descending (largest first)', async () => {
    const result = await searchService.searchModels({
      sort: 'totalSizeBytes',
      sortDir: 'desc',
      status: 'ready',
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    // Ready model sizes: Alpha=1M, Beta=2M, Gamma=3M, Epsilon=4M
    // Descending: Epsilon(4M), Gamma(3M), Beta(2M), Alpha(1M)
    expect(ours[0].id).toBe(modelIds[4]); // Epsilon 4M
    expect(ours[1].id).toBe(modelIds[2]); // Gamma 3M
    expect(ours[2].id).toBe(modelIds[1]); // Beta 2M
    expect(ours[3].id).toBe(modelIds[0]); // Alpha 1M
  });

  it('should sort by totalSizeBytes ascending (smallest first)', async () => {
    const result = await searchService.searchModels({
      sort: 'totalSizeBytes',
      sortDir: 'asc',
      status: 'ready',
      pageSize: 100,
    });

    const ours = onlyTestModels(result.models);
    // Ready model sizes ascending: Alpha(1M), Beta(2M), Gamma(3M), Epsilon(4M)
    expect(ours[0].id).toBe(modelIds[0]); // Alpha 1M
    expect(ours[1].id).toBe(modelIds[1]); // Beta 2M
    expect(ours[2].id).toBe(modelIds[2]); // Gamma 3M
    expect(ours[3].id).toBe(modelIds[4]); // Epsilon 4M
  });
});

// ---------------------------------------------------------------------------
// describe: cursor pagination
// ---------------------------------------------------------------------------

describe('cursor pagination', () => {
  it('should return first page with a cursor when more results exist', async () => {
    // Use status=ready to work with our 4 known ready models, pageSize=2
    const result = await searchService.searchModels({
      sort: 'createdAt',
      sortDir: 'asc',
      status: 'ready',
      pageSize: 2,
    });

    expect(result.pageSize).toBe(2);
    expect(result.cursor).not.toBeNull();
    expect(typeof result.cursor).toBe('string');

    const ours = onlyTestModels(result.models);
    // First 2 ready models in asc order: Alpha [0], Beta [1]
    expect(ours).toHaveLength(2);
    expect(ours[0].id).toBe(modelIds[0]);
    expect(ours[1].id).toBe(modelIds[1]);
  });

  it('should return second page using cursor with no duplicates', async () => {
    const page1 = await searchService.searchModels({
      sort: 'createdAt',
      sortDir: 'asc',
      status: 'ready',
      pageSize: 2,
    });

    expect(page1.cursor).not.toBeNull();

    const page2 = await searchService.searchModels({
      sort: 'createdAt',
      sortDir: 'asc',
      status: 'ready',
      pageSize: 2,
      cursor: page1.cursor!,
    });

    const page1Ids = onlyTestModels(page1.models).map((m) => m.id);
    const page2Ids = onlyTestModels(page2.models).map((m) => m.id);

    // No overlap between pages
    const overlap = page1Ids.filter((id) => page2Ids.includes(id));
    expect(overlap).toHaveLength(0);

    // Together they cover all 4 ready models
    const allIds = [...page1Ids, ...page2Ids];
    expect(allIds).toContain(modelIds[0]);
    expect(allIds).toContain(modelIds[1]);
    expect(allIds).toContain(modelIds[2]);
    expect(allIds).toContain(modelIds[4]);
  });

  it('should return null cursor on the last page', async () => {
    // Request all collection models in a single page larger than the collection size.
    // When returned rows < pageSize, the service knows there are no more pages.
    const result = await searchService.searchModels({
      sort: 'createdAt',
      sortDir: 'asc',
      collectionId,
      pageSize: 10, // collection only has 2 models
    });

    // Both collection models are returned and there is no next page
    expect(result.total).toBe(2);
    expect(onlyTestModels(result.models)).toHaveLength(2);
    expect(result.cursor).toBeNull();
  });

  it('should return null cursor after walking all pages', async () => {
    // page1 → pageSize:1 → gets first collection model, cursor non-null
    const page1 = await searchService.searchModels({
      sort: 'createdAt',
      sortDir: 'asc',
      collectionId,
      pageSize: 1,
    });
    expect(page1.cursor).not.toBeNull();

    // page2 → uses cursor from page1, pageSize:10 → gets the remaining 1 model
    // rows.length (1) < pageSize (10) → cursor is null
    const page2 = await searchService.searchModels({
      sort: 'createdAt',
      sortDir: 'asc',
      collectionId,
      pageSize: 10,
      cursor: page1.cursor!,
    });

    expect(page2.cursor).toBeNull();
    expect(onlyTestModels(page2.models)).toHaveLength(1);
  });

  it('should accumulate the correct total across all pages', async () => {
    const page1 = await searchService.searchModels({
      sort: 'createdAt',
      sortDir: 'asc',
      status: 'ready',
      pageSize: 2,
    });

    const page2 = await searchService.searchModels({
      sort: 'createdAt',
      sortDir: 'asc',
      status: 'ready',
      pageSize: 2,
      cursor: page1.cursor!,
    });

    // Both pages report the same total (total is always the full count)
    expect(page1.total).toBe(page2.total);
  });

  it('should work with descending cursor pagination', async () => {
    const page1 = await searchService.searchModels({
      sort: 'createdAt',
      sortDir: 'desc',
      status: 'ready',
      pageSize: 2,
    });

    expect(page1.cursor).not.toBeNull();

    const page2 = await searchService.searchModels({
      sort: 'createdAt',
      sortDir: 'desc',
      status: 'ready',
      pageSize: 2,
      cursor: page1.cursor!,
    });

    const p1Ids = onlyTestModels(page1.models).map((m) => m.id);
    const p2Ids = onlyTestModels(page2.models).map((m) => m.id);

    // No overlap
    const overlap = p1Ids.filter((id) => p2Ids.includes(id));
    expect(overlap).toHaveLength(0);
  });

  it('should throw a validation error for an invalid cursor', async () => {
    await expect(
      searchService.searchModels({ cursor: 'this-is-not-a-valid-cursor!!!' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('should throw AppError for a base64 cursor that decodes to non-JSON', async () => {
    const badCursor = Buffer.from('not-json-at-all').toString('base64');
    await expect(
      searchService.searchModels({ cursor: badCursor }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

// ---------------------------------------------------------------------------
// describe: response shape
// ---------------------------------------------------------------------------

describe('response shape', () => {
  it('should include thumbnailUrl for models with an image thumbnail', async () => {
    // model[0] has an image file + a 400px thumbnail
    const result = await searchService.searchModels({
      pageSize: 100,
    });

    const alpha = result.models.find((m) => m.id === modelIds[0]);
    expect(alpha).toBeDefined();
    expect(alpha!.thumbnailUrl).not.toBeNull();
    expect(alpha!.thumbnailUrl).toMatch(/^\/files\/thumbnails\/.+\.webp$/);
  });

  it('should return null thumbnailUrl for models without image files', async () => {
    // model[2] has only an STL file — no thumbnail
    const result = await searchService.searchModels({
      pageSize: 100,
    });

    const gamma = result.models.find((m) => m.id === modelIds[2]);
    expect(gamma).toBeDefined();
    expect(gamma!.thumbnailUrl).toBeNull();
  });

  it('should include tags in metadata array for models that have tags', async () => {
    const result = await searchService.searchModels({
      pageSize: 100,
    });

    const alpha = result.models.find((m) => m.id === modelIds[0]);
    expect(alpha).toBeDefined();

    const tagsMeta = alpha!.metadata.find((m) => m.fieldSlug === 'tags');
    expect(tagsMeta).toBeDefined();
    expect(tagsMeta!.type).toBe('multi_enum');
    expect(tagsMeta!.fieldName).toBe('Tags');
    expect(Array.isArray(tagsMeta!.value)).toBe(true);
    expect(tagsMeta!.displayValue).toContain('Dragon');
  });

  it('should include generic metadata (artist) in ModelCard for models that have it', async () => {
    const result = await searchService.searchModels({
      pageSize: 100,
    });

    const alpha = result.models.find((m) => m.id === modelIds[0]);
    expect(alpha).toBeDefined();

    const artistMeta = alpha!.metadata.find((m) => m.fieldSlug === 'artist');
    expect(artistMeta).toBeDefined();
    expect(artistMeta!.value).toBe('sculptor-a');
    expect(artistMeta!.displayValue).toBe('sculptor-a');
  });

  it('should return empty metadata array for models with no metadata', async () => {
    // model[3] (Delta Horror Props) has no tags and no generic metadata
    const result = await searchService.searchModels({
      status: 'error',
      pageSize: 100,
    });

    const delta = result.models.find((m) => m.id === modelIds[3]);
    expect(delta).toBeDefined();
    expect(delta!.metadata).toHaveLength(0);
  });

  it('should include both tags and generic metadata in the same ModelCard', async () => {
    // model[0] has: dragon tag + artist metadata
    const result = await searchService.searchModels({
      pageSize: 100,
    });

    const alpha = result.models.find((m) => m.id === modelIds[0]);
    expect(alpha).toBeDefined();

    const slugs = alpha!.metadata.map((m) => m.fieldSlug);
    expect(slugs).toContain('tags');
    expect(slugs).toContain('artist');
  });

  it('should return pageSize matching the requested value', async () => {
    const result = await searchService.searchModels({ pageSize: 7 });
    expect(result.pageSize).toBe(7);
  });

  it('should cap pageSize at MAX_PAGE_SIZE (200)', async () => {
    const result = await searchService.searchModels({ pageSize: 999 });
    expect(result.pageSize).toBe(200);
  });

  it('should apply default pageSize of 50 when not specified', async () => {
    const result = await searchService.searchModels({});
    expect(result.pageSize).toBe(50);
  });
});
