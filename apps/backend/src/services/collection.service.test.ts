import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, models, collections, collectionModels } from '../db/schema/index.js';
import { collectionService, CollectionService } from './collection.service.js';
import { AppError } from '../utils/errors.js';
import type { CollectionDetail, CollectionSummary, Collection } from '@alexandria/shared';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
//
// These tests require a running PostgreSQL database (the test DB started by
// Docker Compose). The DATABASE_URL env var is set in vitest.config.ts to
// point at the test database.
//
// All tests share a single test user and 3 test models created in beforeAll.
// Collections and collection_models are wiped before each test so that every
// test starts from a known empty state.
// ---------------------------------------------------------------------------

const NULL_UUID = '00000000-0000-0000-0000-000000000000';

let testUserId: string;
let testModelId1: string;
let testModelId2: string;
let testModelId3: string;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Remove any leftover test fixtures from previous failed runs.
  // Must delete collections (which reference user) before deleting the user.
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'collection-test@example.com'))
    .limit(1);

  if (existingUser) {
    await db.delete(collections).where(eq(collections.userId, existingUser.id));
    await db.delete(models).where(eq(models.userId, existingUser.id));
    await db.delete(users).where(eq(users.id, existingUser.id));
  }

  // Create a test user
  const [testUser] = await db
    .insert(users)
    .values({
      email: 'collection-test@example.com',
      displayName: 'Collection Test User',
      passwordHash: 'not-a-real-hash',
      role: 'user',
    })
    .returning();

  testUserId = testUser.id;

  // Create test models owned by the test user
  const [model1] = await db
    .insert(models)
    .values({
      name: 'Collection Test Model 1',
      slug: `collection-test-model-1-${Date.now()}`,
      userId: testUserId,
      sourceType: 'zip_upload',
      status: 'ready',
    })
    .returning();
  testModelId1 = model1.id;

  const [model2] = await db
    .insert(models)
    .values({
      name: 'Collection Test Model 2',
      slug: `collection-test-model-2-${Date.now()}`,
      userId: testUserId,
      sourceType: 'zip_upload',
      status: 'ready',
    })
    .returning();
  testModelId2 = model2.id;

  const [model3] = await db
    .insert(models)
    .values({
      name: 'Collection Test Model 3',
      slug: `collection-test-model-3-${Date.now()}`,
      userId: testUserId,
      sourceType: 'zip_upload',
      status: 'ready',
    })
    .returning();
  testModelId3 = model3.id;
});

afterAll(async () => {
  // Delete collections first — they reference the user via FK.
  if (testUserId) {
    await db.delete(collections).where(eq(collections.userId, testUserId));
  }

  // Remove test models (CASCADE removes collection_models)
  await db
    .delete(models)
    .where(
      inArray(models.id, [testModelId1, testModelId2, testModelId3].filter(Boolean)),
    );

  // Remove test user
  if (testUserId) {
    await db.delete(users).where(eq(users.id, testUserId));
  }
});

beforeEach(async () => {
  // Wipe all collections owned by the test user so each test starts clean.
  // collection_models CASCADE-deletes when collection is removed.
  await db.delete(collections).where(eq(collections.userId, testUserId));
});

// ---------------------------------------------------------------------------
// createCollection()
// ---------------------------------------------------------------------------

describe('CollectionService – createCollection()', () => {
  it('should create a collection and return a Collection shape', async () => {
    const result = await collectionService.createCollection(
      { name: 'My First Collection' },
      testUserId,
    );

    expect(typeof result.id).toBe('string');
    expect(result.name).toBe('My First Collection');
    expect(typeof result.slug).toBe('string');
    expect(result.slug.length).toBeGreaterThan(0);
    expect(result.userId).toBe(testUserId);
    expect(result.parentCollectionId).toBeNull();
    expect(result.description).toBeNull();
    expect(typeof result.createdAt).toBe('string');
    expect(typeof result.updatedAt).toBe('string');
  });

  it('should create a collection with a description', async () => {
    const result = await collectionService.createCollection(
      { name: 'Described Collection', description: 'A helpful description' },
      testUserId,
    );

    expect(result.description).toBe('A helpful description');
  });

  it('should create a child collection when a valid parentCollectionId is provided', async () => {
    const parent = await collectionService.createCollection(
      { name: 'Parent Collection' },
      testUserId,
    );

    const child = await collectionService.createCollection(
      { name: 'Child Collection', parentCollectionId: parent.id },
      testUserId,
    );

    expect(child.parentCollectionId).toBe(parent.id);
  });

  it('should throw AppError with code NOT_FOUND when parentCollectionId does not exist', async () => {
    await expect(
      collectionService.createCollection(
        { name: 'Orphan Collection', parentCollectionId: NULL_UUID },
        testUserId,
      ),
    ).rejects.toThrow(AppError);

    await expect(
      collectionService.createCollection(
        { name: 'Orphan Collection', parentCollectionId: NULL_UUID },
        testUserId,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// getCollectionById()
// ---------------------------------------------------------------------------

describe('CollectionService – getCollectionById()', () => {
  it('should return the collection when it exists', async () => {
    const created = await collectionService.createCollection(
      { name: 'Get By ID Test' },
      testUserId,
    );

    const fetched = await collectionService.getCollectionById(created.id);

    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe('Get By ID Test');
    expect(fetched.userId).toBe(testUserId);
  });

  it('should return a Collection with all required fields', async () => {
    const created = await collectionService.createCollection(
      { name: 'Shape Test Collection', description: 'desc' },
      testUserId,
    );

    const fetched = await collectionService.getCollectionById(created.id);

    expect(typeof fetched.id).toBe('string');
    expect(typeof fetched.name).toBe('string');
    expect(typeof fetched.slug).toBe('string');
    expect(typeof fetched.userId).toBe('string');
    expect(typeof fetched.createdAt).toBe('string');
    expect(typeof fetched.updatedAt).toBe('string');
  });

  it('should throw AppError with code NOT_FOUND when id does not exist', async () => {
    await expect(
      collectionService.getCollectionById(NULL_UUID),
    ).rejects.toThrow(AppError);

    await expect(
      collectionService.getCollectionById(NULL_UUID),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// getCollectionDetail()
// ---------------------------------------------------------------------------

describe('CollectionService – getCollectionDetail()', () => {
  it('should return a CollectionDetail shape with children and modelCount', async () => {
    const col = await collectionService.createCollection(
      { name: 'Detail Test Collection' },
      testUserId,
    );

    const detail = await collectionService.getCollectionDetail(col.id);

    expect(detail.id).toBe(col.id);
    expect(detail.name).toBe('Detail Test Collection');
    expect(typeof detail.slug).toBe('string');
    expect(Array.isArray(detail.children)).toBe(true);
    expect(typeof detail.modelCount).toBe('number');
    expect(typeof detail.createdAt).toBe('string');
    expect(typeof detail.updatedAt).toBe('string');
  });

  it('should return an empty children array when collection has no children', async () => {
    const col = await collectionService.createCollection(
      { name: 'Childless Collection' },
      testUserId,
    );

    const detail = await collectionService.getCollectionDetail(col.id);

    expect(detail.children).toEqual([]);
  });

  it('should list direct children as CollectionSummary[] in the detail', async () => {
    const parent = await collectionService.createCollection(
      { name: 'Parent with Children' },
      testUserId,
    );
    const childA = await collectionService.createCollection(
      { name: 'Child A', parentCollectionId: parent.id },
      testUserId,
    );
    const childB = await collectionService.createCollection(
      { name: 'Child B', parentCollectionId: parent.id },
      testUserId,
    );

    const detail = await collectionService.getCollectionDetail(parent.id);

    expect(detail.children.length).toBe(2);
    const childIds = detail.children.map((c: CollectionSummary) => c.id);
    expect(childIds).toContain(childA.id);
    expect(childIds).toContain(childB.id);

    // Each child should be a CollectionSummary with id, name, slug
    for (const child of detail.children) {
      expect(typeof child.id).toBe('string');
      expect(typeof child.name).toBe('string');
      expect(typeof child.slug).toBe('string');
    }
  });

  it('should return the correct modelCount after adding models', async () => {
    const col = await collectionService.createCollection(
      { name: 'Model Count Test' },
      testUserId,
    );

    await collectionService.addModelsToCollection(col.id, [testModelId1, testModelId2]);

    const detail = await collectionService.getCollectionDetail(col.id);

    expect(detail.modelCount).toBe(2);
  });

  it('should return modelCount of 0 when no models are in the collection', async () => {
    const col = await collectionService.createCollection(
      { name: 'Empty Collection' },
      testUserId,
    );

    const detail = await collectionService.getCollectionDetail(col.id);

    expect(detail.modelCount).toBe(0);
  });

  it('should throw AppError with code NOT_FOUND when id does not exist', async () => {
    await expect(
      collectionService.getCollectionDetail(NULL_UUID),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// listCollections()
// ---------------------------------------------------------------------------

describe('CollectionService – listCollections()', () => {
  it('should return an empty array when the user has no collections', async () => {
    const result = await collectionService.listCollections(testUserId);

    expect(result).toEqual([]);
  });

  it('should return only top-level collections (parentCollectionId IS NULL)', async () => {
    const top1 = await collectionService.createCollection(
      { name: 'Top Level 1' },
      testUserId,
    );
    const top2 = await collectionService.createCollection(
      { name: 'Top Level 2' },
      testUserId,
    );
    await collectionService.createCollection(
      { name: 'Child of Top 1', parentCollectionId: top1.id },
      testUserId,
    );

    const result = await collectionService.listCollections(testUserId);

    expect(result.length).toBe(2);
    const resultIds = result.map((c) => c.id);
    expect(resultIds).toContain(top1.id);
    expect(resultIds).toContain(top2.id);
  });

  it('should return CollectionDetail[] with children populated at depth=1', async () => {
    const top = await collectionService.createCollection(
      { name: 'Top with Sub' },
      testUserId,
    );
    const child = await collectionService.createCollection(
      { name: 'Sub Collection', parentCollectionId: top.id },
      testUserId,
    );

    const result = await collectionService.listCollections(testUserId, { depth: 1 });

    const topDetail = result.find((c) => c.id === top.id);
    expect(topDetail).toBeDefined();
    expect(topDetail!.children.length).toBe(1);
    expect(topDetail!.children[0].id).toBe(child.id);
  });

  it('should return modelCount in each CollectionDetail', async () => {
    const col = await collectionService.createCollection(
      { name: 'List With Models' },
      testUserId,
    );
    await collectionService.addModelsToCollection(col.id, [testModelId1]);

    const result = await collectionService.listCollections(testUserId);

    const found = result.find((c) => c.id === col.id);
    expect(found).toBeDefined();
    expect(found!.modelCount).toBe(1);
  });

  it('should return collections ordered by createdAt', async () => {
    const first = await collectionService.createCollection(
      { name: 'First Created' },
      testUserId,
    );
    // Small delay to ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 10));
    const second = await collectionService.createCollection(
      { name: 'Second Created' },
      testUserId,
    );

    const result = await collectionService.listCollections(testUserId);

    const ids = result.map((c) => c.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
  });
});

// ---------------------------------------------------------------------------
// updateCollection()
// ---------------------------------------------------------------------------

describe('CollectionService – updateCollection()', () => {
  it("should update a collection's name and regenerate its slug", async () => {
    const col = await collectionService.createCollection(
      { name: 'Original Name' },
      testUserId,
    );

    const updated = await collectionService.updateCollection(col.id, {
      name: 'Updated Name',
    });

    expect(updated.id).toBe(col.id);
    expect(updated.name).toBe('Updated Name');
    expect(updated.slug).not.toBe(col.slug);
    expect(updated.slug).toContain('updated-name');
  });

  it("should update a collection's description", async () => {
    const col = await collectionService.createCollection(
      { name: 'No Description Yet' },
      testUserId,
    );

    const updated = await collectionService.updateCollection(col.id, {
      description: 'Now it has one',
    });

    expect(updated.description).toBe('Now it has one');
  });

  it('should clear the description when null is passed', async () => {
    const col = await collectionService.createCollection(
      { name: 'Has Description', description: 'To be cleared' },
      testUserId,
    );

    const updated = await collectionService.updateCollection(col.id, {
      description: null,
    });

    expect(updated.description).toBeNull();
  });

  it('should move a collection to a different parent', async () => {
    const parentA = await collectionService.createCollection(
      { name: 'Parent A' },
      testUserId,
    );
    const parentB = await collectionService.createCollection(
      { name: 'Parent B' },
      testUserId,
    );
    const child = await collectionService.createCollection(
      { name: 'Moveable Child', parentCollectionId: parentA.id },
      testUserId,
    );

    const moved = await collectionService.updateCollection(child.id, {
      parentCollectionId: parentB.id,
    });

    expect(moved.parentCollectionId).toBe(parentB.id);
  });

  it('should detach a collection from its parent when parentCollectionId is set to null', async () => {
    const parent = await collectionService.createCollection(
      { name: 'Detach Parent' },
      testUserId,
    );
    const child = await collectionService.createCollection(
      { name: 'Will Detach', parentCollectionId: parent.id },
      testUserId,
    );

    const detached = await collectionService.updateCollection(child.id, {
      parentCollectionId: null,
    });

    expect(detached.parentCollectionId).toBeNull();
  });

  it('should throw AppError with code VALIDATION_ERROR when setting parent to a direct child', async () => {
    const parent = await collectionService.createCollection(
      { name: 'Cycle Parent' },
      testUserId,
    );
    const child = await collectionService.createCollection(
      { name: 'Cycle Child', parentCollectionId: parent.id },
      testUserId,
    );

    await expect(
      collectionService.updateCollection(parent.id, {
        parentCollectionId: child.id,
      }),
    ).rejects.toThrow(AppError);

    await expect(
      collectionService.updateCollection(parent.id, {
        parentCollectionId: child.id,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('should throw VALIDATION_ERROR when setting parent to a deeper descendant', async () => {
    const grandparent = await collectionService.createCollection(
      { name: 'Grandparent' },
      testUserId,
    );
    const parent = await collectionService.createCollection(
      { name: 'Parent', parentCollectionId: grandparent.id },
      testUserId,
    );
    const grandchild = await collectionService.createCollection(
      { name: 'Grandchild', parentCollectionId: parent.id },
      testUserId,
    );

    await expect(
      collectionService.updateCollection(grandparent.id, {
        parentCollectionId: grandchild.id,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('should throw AppError with code NOT_FOUND when updating a non-existent collection', async () => {
    await expect(
      collectionService.updateCollection(NULL_UUID, { name: 'Ghost' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('should throw AppError with code NOT_FOUND when the new parentCollectionId does not exist', async () => {
    const col = await collectionService.createCollection(
      { name: 'Needs Valid Parent' },
      testUserId,
    );

    await expect(
      collectionService.updateCollection(col.id, {
        parentCollectionId: NULL_UUID,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// deleteCollection()
// ---------------------------------------------------------------------------

describe('CollectionService – deleteCollection()', () => {
  it('should delete a collection so it is no longer fetchable', async () => {
    const col = await collectionService.createCollection(
      { name: 'To Be Deleted' },
      testUserId,
    );

    await collectionService.deleteCollection(col.id);

    await expect(
      collectionService.getCollectionById(col.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('should make child collections top-level (parentCollectionId = null) when parent is deleted', async () => {
    const parent = await collectionService.createCollection(
      { name: 'Parent To Delete' },
      testUserId,
    );
    const child = await collectionService.createCollection(
      { name: 'Child Will Survive', parentCollectionId: parent.id },
      testUserId,
    );

    await collectionService.deleteCollection(parent.id);

    // Child should still exist
    const survivingChild = await collectionService.getCollectionById(child.id);
    expect(survivingChild).toBeDefined();
    expect(survivingChild.parentCollectionId).toBeNull();
  });

  it('should NOT delete models that were in the deleted collection', async () => {
    const col = await collectionService.createCollection(
      { name: 'Collection With Models' },
      testUserId,
    );
    await collectionService.addModelsToCollection(col.id, [testModelId1]);

    await collectionService.deleteCollection(col.id);

    // The model should still exist in the DB
    const [modelRow] = await db
      .select()
      .from(models)
      .where(eq(models.id, testModelId1))
      .limit(1);

    expect(modelRow).toBeDefined();
    expect(modelRow.id).toBe(testModelId1);
  });

  it('should remove collection_models entries when the collection is deleted', async () => {
    const col = await collectionService.createCollection(
      { name: 'Membership Cleanup' },
      testUserId,
    );
    await collectionService.addModelsToCollection(col.id, [testModelId1]);

    await collectionService.deleteCollection(col.id);

    const membershipRows = await db
      .select()
      .from(collectionModels)
      .where(eq(collectionModels.collectionId, col.id));

    expect(membershipRows.length).toBe(0);
  });

  it('should throw AppError with code NOT_FOUND when deleting a non-existent collection', async () => {
    await expect(
      collectionService.deleteCollection(NULL_UUID),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// addModelsToCollection()
// ---------------------------------------------------------------------------

describe('CollectionService – addModelsToCollection()', () => {
  it('should add models to a collection', async () => {
    const col = await collectionService.createCollection(
      { name: 'Add Models Test' },
      testUserId,
    );

    await collectionService.addModelsToCollection(col.id, [testModelId1, testModelId2]);

    const rows = await db
      .select()
      .from(collectionModels)
      .where(eq(collectionModels.collectionId, col.id));

    expect(rows.length).toBe(2);
    const modelIds = rows.map((r) => r.modelId);
    expect(modelIds).toContain(testModelId1);
    expect(modelIds).toContain(testModelId2);
  });

  it('should be idempotent — adding the same model twice does not error or duplicate', async () => {
    const col = await collectionService.createCollection(
      { name: 'Idempotent Add' },
      testUserId,
    );

    await collectionService.addModelsToCollection(col.id, [testModelId1]);
    await collectionService.addModelsToCollection(col.id, [testModelId1]);

    const rows = await db
      .select()
      .from(collectionModels)
      .where(eq(collectionModels.collectionId, col.id));

    expect(rows.length).toBe(1);
  });

  it('should do nothing when modelIds is an empty array', async () => {
    const col = await collectionService.createCollection(
      { name: 'Empty Add' },
      testUserId,
    );

    // Should not throw
    await expect(
      collectionService.addModelsToCollection(col.id, []),
    ).resolves.toBeUndefined();

    const rows = await db
      .select()
      .from(collectionModels)
      .where(eq(collectionModels.collectionId, col.id));

    expect(rows.length).toBe(0);
  });

  it('should add the same model to multiple different collections', async () => {
    const colA = await collectionService.createCollection(
      { name: 'Multi-Collection A' },
      testUserId,
    );
    const colB = await collectionService.createCollection(
      { name: 'Multi-Collection B' },
      testUserId,
    );

    await collectionService.addModelsToCollection(colA.id, [testModelId1]);
    await collectionService.addModelsToCollection(colB.id, [testModelId1]);

    const rowsA = await db
      .select()
      .from(collectionModels)
      .where(eq(collectionModels.collectionId, colA.id));
    const rowsB = await db
      .select()
      .from(collectionModels)
      .where(eq(collectionModels.collectionId, colB.id));

    expect(rowsA.length).toBe(1);
    expect(rowsB.length).toBe(1);
    expect(rowsA[0].modelId).toBe(testModelId1);
    expect(rowsB[0].modelId).toBe(testModelId1);
  });

  it('should throw AppError with code NOT_FOUND when collectionId does not exist', async () => {
    await expect(
      collectionService.addModelsToCollection(NULL_UUID, [testModelId1]),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// removeModelFromCollection()
// ---------------------------------------------------------------------------

describe('CollectionService – removeModelFromCollection()', () => {
  it('should remove a model from a collection', async () => {
    const col = await collectionService.createCollection(
      { name: 'Remove Model Test' },
      testUserId,
    );
    await collectionService.addModelsToCollection(col.id, [testModelId1, testModelId2]);

    await collectionService.removeModelFromCollection(col.id, testModelId1);

    const rows = await db
      .select()
      .from(collectionModels)
      .where(eq(collectionModels.collectionId, col.id));

    expect(rows.length).toBe(1);
    expect(rows[0].modelId).toBe(testModelId2);
  });

  it('should not throw when removing a model that is not in the collection', async () => {
    const col = await collectionService.createCollection(
      { name: 'Remove Non-Member' },
      testUserId,
    );

    // testModelId3 was never added — should silently succeed
    await expect(
      collectionService.removeModelFromCollection(col.id, testModelId3),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// bulkCollectionOperation()
// ---------------------------------------------------------------------------

describe('CollectionService – bulkCollectionOperation() with action=add', () => {
  it('should add multiple models to a collection', async () => {
    const col = await collectionService.createCollection(
      { name: 'Bulk Add Target' },
      testUserId,
    );

    await collectionService.bulkCollectionOperation({
      action: 'add',
      collectionId: col.id,
      modelIds: [testModelId1, testModelId2, testModelId3],
    });

    const rows = await db
      .select()
      .from(collectionModels)
      .where(eq(collectionModels.collectionId, col.id));

    expect(rows.length).toBe(3);
  });

  it('should be idempotent — re-adding existing models does not error', async () => {
    const col = await collectionService.createCollection(
      { name: 'Bulk Add Idempotent' },
      testUserId,
    );

    await collectionService.bulkCollectionOperation({
      action: 'add',
      collectionId: col.id,
      modelIds: [testModelId1],
    });
    await collectionService.bulkCollectionOperation({
      action: 'add',
      collectionId: col.id,
      modelIds: [testModelId1],
    });

    const rows = await db
      .select()
      .from(collectionModels)
      .where(eq(collectionModels.collectionId, col.id));

    expect(rows.length).toBe(1);
  });

  it('should do nothing when modelIds is empty', async () => {
    const col = await collectionService.createCollection(
      { name: 'Bulk Add Empty' },
      testUserId,
    );

    await expect(
      collectionService.bulkCollectionOperation({
        action: 'add',
        collectionId: col.id,
        modelIds: [],
      }),
    ).resolves.toBeUndefined();
  });
});

describe('CollectionService – bulkCollectionOperation() with action=remove', () => {
  it('should remove only the specified models, leaving others intact', async () => {
    const col = await collectionService.createCollection(
      { name: 'Bulk Remove Selective' },
      testUserId,
    );
    await collectionService.addModelsToCollection(col.id, [
      testModelId1,
      testModelId2,
      testModelId3,
    ]);

    await collectionService.bulkCollectionOperation({
      action: 'remove',
      collectionId: col.id,
      modelIds: [testModelId1, testModelId2],
    });

    const rows = await db
      .select()
      .from(collectionModels)
      .where(eq(collectionModels.collectionId, col.id));

    expect(rows.length).toBe(1);
    expect(rows[0].modelId).toBe(testModelId3);
  });

  it('should not throw when removing models that are not in the collection', async () => {
    const col = await collectionService.createCollection(
      { name: 'Bulk Remove Non-Members' },
      testUserId,
    );

    await expect(
      collectionService.bulkCollectionOperation({
        action: 'remove',
        collectionId: col.id,
        modelIds: [testModelId1, testModelId2],
      }),
    ).resolves.toBeUndefined();
  });

  it('should do nothing when modelIds is empty', async () => {
    const col = await collectionService.createCollection(
      { name: 'Bulk Remove Empty' },
      testUserId,
    );
    await collectionService.addModelsToCollection(col.id, [testModelId1]);

    await collectionService.bulkCollectionOperation({
      action: 'remove',
      collectionId: col.id,
      modelIds: [],
    });

    const rows = await db
      .select()
      .from(collectionModels)
      .where(eq(collectionModels.collectionId, col.id));

    expect(rows.length).toBe(1);
  });

  it('should throw AppError with code NOT_FOUND when collectionId does not exist', async () => {
    await expect(
      collectionService.bulkCollectionOperation({
        action: 'remove',
        collectionId: NULL_UUID,
        modelIds: [testModelId1],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// findOrCreateByName() — Phase 4 compatibility
// ---------------------------------------------------------------------------

describe('CollectionService – findOrCreateByName()', () => {
  it('should create a new collection when no matching name exists', async () => {
    const result = await collectionService.findOrCreateByName(
      'Brand New Collection',
      testUserId,
    );

    expect(typeof result.id).toBe('string');
    expect(result.name).toBe('Brand New Collection');

    // Verify it exists in the DB
    const [row] = await db
      .select()
      .from(collections)
      .where(eq(collections.id, result.id))
      .limit(1);
    expect(row).toBeDefined();
  });

  it('should return the existing collection when the same name already exists', async () => {
    const first = await collectionService.findOrCreateByName(
      'Existing Collection',
      testUserId,
    );

    const second = await collectionService.findOrCreateByName(
      'Existing Collection',
      testUserId,
    );

    expect(second.id).toBe(first.id);
    expect(second.name).toBe(first.name);
  });

  it('should match case-insensitively when finding an existing collection', async () => {
    const first = await collectionService.findOrCreateByName(
      'Case Collection',
      testUserId,
    );

    const found = await collectionService.findOrCreateByName(
      'CASE COLLECTION',
      testUserId,
    );

    expect(found.id).toBe(first.id);
  });

  it('should return only id and name fields', async () => {
    const result = await collectionService.findOrCreateByName(
      'Shape Check Collection',
      testUserId,
    );

    expect(typeof result.id).toBe('string');
    expect(typeof result.name).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Parent-child nesting and tree structure
// ---------------------------------------------------------------------------

describe('CollectionService – parent-child nesting', () => {
  it('should support a 3-level deep hierarchy', async () => {
    const grandparent = await collectionService.createCollection(
      { name: 'GP Level' },
      testUserId,
    );
    const parent = await collectionService.createCollection(
      { name: 'P Level', parentCollectionId: grandparent.id },
      testUserId,
    );
    const child = await collectionService.createCollection(
      { name: 'C Level', parentCollectionId: parent.id },
      testUserId,
    );

    expect(child.parentCollectionId).toBe(parent.id);
    expect(parent.parentCollectionId).toBe(grandparent.id);
    expect(grandparent.parentCollectionId).toBeNull();
  });

  it('should not include nested collections in listCollections() top-level results', async () => {
    const top = await collectionService.createCollection(
      { name: 'Top Nesting Test' },
      testUserId,
    );
    await collectionService.createCollection(
      { name: 'Nested Child', parentCollectionId: top.id },
      testUserId,
    );

    const result = await collectionService.listCollections(testUserId);

    // Only top-level
    for (const c of result) {
      expect(c.parentCollectionId).toBeNull();
    }
    expect(result.length).toBe(1);
  });

  it("should populate grandchild's parent correctly when navigating via getCollectionDetail", async () => {
    const root = await collectionService.createCollection(
      { name: 'Root' },
      testUserId,
    );
    const mid = await collectionService.createCollection(
      { name: 'Mid', parentCollectionId: root.id },
      testUserId,
    );

    const rootDetail = await collectionService.getCollectionDetail(root.id);
    const midDetail = await collectionService.getCollectionDetail(mid.id);

    expect(rootDetail.children[0].id).toBe(mid.id);
    expect(midDetail.parentCollectionId).toBe(root.id);
  });
});
