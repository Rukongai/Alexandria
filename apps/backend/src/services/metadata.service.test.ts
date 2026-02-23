import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  users,
  models,
  metadataFieldDefinitions,
  modelMetadata,
  modelTags,
  tags,
} from '../db/schema/index.js';
import { metadataService, MetadataService } from './metadata.service.js';
import { AppError } from '../utils/errors.js';
import type {
  MetadataFieldDetail,
  MetadataFieldValue,
  MetadataValue,
} from '@alexandria/shared';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
//
// These tests require a running PostgreSQL database (the test DB started by
// Docker Compose).  The DATABASE_URL env var is set in vitest.config.ts to
// point at the test database.
//
// All tests share a single test user and test model created in beforeAll.
// Metadata state (model_metadata, model_tags) is wiped before each test so
// that every test starts from a known empty state.
// ---------------------------------------------------------------------------

let testUserId: string;
let testModelId: string;

// Default field slugs as seeded — they have no random suffix.
const DEFAULT_SLUG_TAGS = 'tags';
const DEFAULT_SLUG_ARTIST = 'artist';
const DEFAULT_SLUG_YEAR = 'year';
const DEFAULT_SLUG_NSFW = 'nsfw';
const DEFAULT_SLUG_URL = 'url';
const DEFAULT_SLUG_PRE_SUPPORTED = 'pre-supported';

const ALL_DEFAULT_SLUGS = [
  DEFAULT_SLUG_TAGS,
  DEFAULT_SLUG_ARTIST,
  DEFAULT_SLUG_YEAR,
  DEFAULT_SLUG_NSFW,
  DEFAULT_SLUG_URL,
  DEFAULT_SLUG_PRE_SUPPORTED,
] as const;

// Track custom field IDs created during tests so we can clean them up.
const createdFieldIds: string[] = [];

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Remove any leftover test fixtures from previous failed runs
  await db.delete(users).where(eq(users.email, 'metadata-test@example.com'));

  // Create a test user
  const [testUser] = await db
    .insert(users)
    .values({
      email: 'metadata-test@example.com',
      displayName: 'Metadata Test User',
      passwordHash: 'not-a-real-hash',
      role: 'admin',
    })
    .returning();

  testUserId = testUser.id;

  // Create a test model owned by the test user
  const [testModel] = await db
    .insert(models)
    .values({
      name: 'Metadata Test Model',
      slug: `metadata-test-model-${Date.now()}`,
      userId: testUserId,
      sourceType: 'zip_upload',
      status: 'ready',
    })
    .returning();

  testModelId = testModel.id;
});

afterAll(async () => {
  // Clean up any custom fields created during tests (CASCADE removes modelMetadata rows)
  for (const id of createdFieldIds) {
    await db
      .delete(metadataFieldDefinitions)
      .where(
        and(
          eq(metadataFieldDefinitions.id, id),
          eq(metadataFieldDefinitions.isDefault, false),
        ),
      );
  }

  // Remove model (CASCADE removes model_tags and model_metadata)
  if (testModelId) {
    await db.delete(models).where(eq(models.id, testModelId));
  }

  // Remove test user
  if (testUserId) {
    await db.delete(users).where(eq(users.id, testUserId));
  }
});

beforeEach(async () => {
  // Reset metadata state for the test model so each test starts clean
  await db.delete(modelTags).where(eq(modelTags.modelId, testModelId));
  await db.delete(modelMetadata).where(eq(modelMetadata.modelId, testModelId));
});

// ---------------------------------------------------------------------------
// Unit Tests: routing logic (isTagField)
// ---------------------------------------------------------------------------
//
// These tests exercise the private routing logic without a real database by
// constructing a fresh MetadataService instance and calling setModelMetadata
// against a real model, then verifying which table received the write.
// ---------------------------------------------------------------------------

describe('MetadataService – storage routing logic', () => {
  it('should route the tags field (slug=tags, type=multi_enum, isDefault=true) to model_tags table', async () => {
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_TAGS]: ['dragon', 'fantasy'],
    });

    // Verify rows exist in model_tags, not model_metadata
    const tagRows = await db
      .select()
      .from(modelTags)
      .where(eq(modelTags.modelId, testModelId));
    expect(tagRows.length).toBe(2);

    const metaRows = await db
      .select()
      .from(modelMetadata)
      .where(eq(modelMetadata.modelId, testModelId));
    expect(metaRows.length).toBe(0);
  });

  it('should route a non-tag field (artist) to model_metadata table, not model_tags', async () => {
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_ARTIST]: 'Test Artist',
    });

    // Verify the row exists in model_metadata
    const artistField = await metadataService.getFieldBySlug(DEFAULT_SLUG_ARTIST);
    const metaRows = await db
      .select()
      .from(modelMetadata)
      .where(
        and(
          eq(modelMetadata.modelId, testModelId),
          eq(modelMetadata.fieldDefinitionId, artistField.id),
        ),
      );
    expect(metaRows.length).toBe(1);
    expect(metaRows[0].value).toBe('Test Artist');

    // And NOT in model_tags
    const tagRows = await db
      .select()
      .from(modelTags)
      .where(eq(modelTags.modelId, testModelId));
    expect(tagRows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration Tests: Field Definition CRUD
// ---------------------------------------------------------------------------

describe('MetadataService – listFields()', () => {
  it('should return all six seeded default fields', async () => {
    const fields = await metadataService.listFields();

    const slugs = fields.map((f) => f.slug);
    for (const slug of ALL_DEFAULT_SLUGS) {
      expect(slugs).toContain(slug);
    }
  });

  it('should return fields ordered by sortOrder', async () => {
    const fields = await metadataService.listFields();

    const defaultFields = fields.filter((f) => f.isDefault);
    const sortOrders = defaultFields.map((f) => f.sortOrder);

    // Every element should be <= the next
    for (let i = 0; i < sortOrders.length - 1; i++) {
      expect(sortOrders[i]).toBeLessThanOrEqual(sortOrders[i + 1]);
    }
  });

  it('should return fields matching the MetadataFieldDetail shape', async () => {
    const fields = await metadataService.listFields();

    expect(fields.length).toBeGreaterThan(0);

    for (const field of fields) {
      expect(typeof field.id).toBe('string');
      expect(typeof field.name).toBe('string');
      expect(typeof field.slug).toBe('string');
      expect(typeof field.type).toBe('string');
      expect(typeof field.isDefault).toBe('boolean');
      expect(typeof field.isFilterable).toBe('boolean');
      expect(typeof field.isBrowsable).toBe('boolean');
      expect(typeof field.sortOrder).toBe('number');
    }
  });
});

describe('MetadataService – createField()', () => {
  it('should create a custom field with a generated slug', async () => {
    const field = await metadataService.createField({
      name: 'Print Scale',
      type: 'number',
      isFilterable: false,
      isBrowsable: false,
    });

    createdFieldIds.push(field.id);

    expect(field.id).toBeTruthy();
    expect(field.name).toBe('Print Scale');
    // Slug is generated from the name — must start with 'print-scale'
    expect(field.slug).toMatch(/^print-scale-[a-z0-9]+$/);
    expect(field.type).toBe('number');
    expect(field.isDefault).toBe(false);
    expect(field.isFilterable).toBe(false);
    expect(field.isBrowsable).toBe(false);
  });

  it('should persist the created field so it appears in listFields()', async () => {
    const created = await metadataService.createField({
      name: 'License Type',
      type: 'text',
    });

    createdFieldIds.push(created.id);

    const fields = await metadataService.listFields();
    const found = fields.find((f) => f.id === created.id);

    expect(found).toBeDefined();
    expect(found!.name).toBe('License Type');
  });
});

describe('MetadataService – updateField()', () => {
  it("should update a field's name and isFilterable flag", async () => {
    // Create a disposable field to mutate
    const created = await metadataService.createField({
      name: 'Color Scheme',
      type: 'text',
      isFilterable: false,
    });
    createdFieldIds.push(created.id);

    const updated = await metadataService.updateField(created.id, {
      name: 'Colour Scheme',
      isFilterable: true,
    });

    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('Colour Scheme');
    expect(updated.isFilterable).toBe(true);
    // Slug should not have changed (updateField does not re-slug)
    expect(updated.slug).toBe(created.slug);
  });

  it('should throw notFound when updating a field that does not exist', async () => {
    await expect(
      metadataService.updateField('00000000-0000-0000-0000-000000000000', {
        name: 'Ghost',
      }),
    ).rejects.toThrow(AppError);

    await expect(
      metadataService.updateField('00000000-0000-0000-0000-000000000000', {
        name: 'Ghost',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('MetadataService – deleteField()', () => {
  it('should delete a custom field', async () => {
    const created = await metadataService.createField({
      name: 'Temporary Field',
      type: 'text',
    });
    // Not tracked for auto-cleanup — we delete it in the test
    const fieldId = created.id;

    await metadataService.deleteField(fieldId);

    // Verify it no longer exists
    await expect(metadataService.getFieldById(fieldId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('should throw FORBIDDEN when deleting a default field', async () => {
    const tagsField = await metadataService.getFieldBySlug(DEFAULT_SLUG_TAGS);

    await expect(
      metadataService.deleteField(tagsField.id),
    ).rejects.toThrow(AppError);

    await expect(
      metadataService.deleteField(tagsField.id),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('MetadataService – getFieldBySlug()', () => {
  it('should return the correct field for a known slug', async () => {
    const field = await metadataService.getFieldBySlug(DEFAULT_SLUG_ARTIST);

    expect(field.slug).toBe(DEFAULT_SLUG_ARTIST);
    expect(field.name).toBe('Artist');
    expect(field.type).toBe('text');
    expect(field.isDefault).toBe(true);
  });

  it('should throw NOT_FOUND for a nonexistent slug', async () => {
    await expect(
      metadataService.getFieldBySlug('does-not-exist-zzz'),
    ).rejects.toThrow(AppError);

    await expect(
      metadataService.getFieldBySlug('does-not-exist-zzz'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('MetadataService – getFieldById()', () => {
  it('should return the correct field for a known id', async () => {
    const bySlug = await metadataService.getFieldBySlug(DEFAULT_SLUG_YEAR);
    const byId = await metadataService.getFieldById(bySlug.id);

    expect(byId.id).toBe(bySlug.id);
    expect(byId.name).toBe('Year');
  });

  it('should throw NOT_FOUND for a nonexistent id', async () => {
    await expect(
      metadataService.getFieldById('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(AppError);

    await expect(
      metadataService.getFieldById('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// Integration Tests: Metadata Value Assignment
// ---------------------------------------------------------------------------

describe('MetadataService – setModelMetadata() with tags', () => {
  it('should store tag values in tags/model_tags tables, not model_metadata', async () => {
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_TAGS]: ['dragon', 'fantasy'],
    });

    // Tags should exist in the tags table
    const [dragonTag] = await db
      .select()
      .from(tags)
      .where(eq(tags.name, 'dragon'))
      .limit(1);
    expect(dragonTag).toBeDefined();

    // model_tags should link the model to both tags
    const modelTagRows = await db
      .select()
      .from(modelTags)
      .where(eq(modelTags.modelId, testModelId));
    expect(modelTagRows.length).toBe(2);

    // Nothing in model_metadata
    const metaRows = await db
      .select()
      .from(modelMetadata)
      .where(eq(modelMetadata.modelId, testModelId));
    expect(metaRows.length).toBe(0);
  });

  it('should reuse an existing tag row when the same tag name is set again', async () => {
    // Set the tag once — creates the tag row
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_TAGS]: ['reuse-tag'],
    });

    const tagsBefore = await db
      .select()
      .from(tags)
      .where(eq(tags.name, 'reuse-tag'));
    expect(tagsBefore.length).toBe(1);
    const originalId = tagsBefore[0].id;

    // Reset model_tags but keep the tag in the tags table (simulate a second model)
    await db.delete(modelTags).where(eq(modelTags.modelId, testModelId));

    // Set the same tag again — should not create a duplicate tag row
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_TAGS]: ['reuse-tag'],
    });

    const tagsAfter = await db
      .select()
      .from(tags)
      .where(eq(tags.name, 'reuse-tag'));
    expect(tagsAfter.length).toBe(1);
    expect(tagsAfter[0].id).toBe(originalId);
  });
});

describe('MetadataService – setModelMetadata() with artist', () => {
  it('should store the value in model_metadata table', async () => {
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_ARTIST]: 'Jane Sculptor',
    });

    const artistField = await metadataService.getFieldBySlug(DEFAULT_SLUG_ARTIST);
    const metaRows = await db
      .select()
      .from(modelMetadata)
      .where(
        and(
          eq(modelMetadata.modelId, testModelId),
          eq(modelMetadata.fieldDefinitionId, artistField.id),
        ),
      );

    expect(metaRows.length).toBe(1);
    expect(metaRows[0].value).toBe('Jane Sculptor');
  });

  it('should upsert (update in place) when called a second time for the same field', async () => {
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_ARTIST]: 'First Artist',
    });
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_ARTIST]: 'Second Artist',
    });

    const artistField = await metadataService.getFieldBySlug(DEFAULT_SLUG_ARTIST);
    const metaRows = await db
      .select()
      .from(modelMetadata)
      .where(
        and(
          eq(modelMetadata.modelId, testModelId),
          eq(modelMetadata.fieldDefinitionId, artistField.id),
        ),
      );

    // Still exactly one row
    expect(metaRows.length).toBe(1);
    expect(metaRows[0].value).toBe('Second Artist');
  });
});

describe('MetadataService – setModelMetadata() with null', () => {
  it('should remove existing metadata value when null is passed for a generic field', async () => {
    // Set a value first
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_ARTIST]: 'To Be Removed',
    });

    // Now remove it
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_ARTIST]: null,
    });

    const artistField = await metadataService.getFieldBySlug(DEFAULT_SLUG_ARTIST);
    const metaRows = await db
      .select()
      .from(modelMetadata)
      .where(
        and(
          eq(modelMetadata.modelId, testModelId),
          eq(modelMetadata.fieldDefinitionId, artistField.id),
        ),
      );

    expect(metaRows.length).toBe(0);
  });

  it('should remove all model tags when null is passed for the tags field', async () => {
    // Set some tags first
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_TAGS]: ['remove-me', 'me-too'],
    });

    const tagsBefore = await db
      .select()
      .from(modelTags)
      .where(eq(modelTags.modelId, testModelId));
    expect(tagsBefore.length).toBe(2);

    // Now null them out
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_TAGS]: null,
    });

    const tagsAfter = await db
      .select()
      .from(modelTags)
      .where(eq(modelTags.modelId, testModelId));
    expect(tagsAfter.length).toBe(0);
  });
});

describe('MetadataService – setModelMetadata() replacing tags', () => {
  it('should replace old tags with a new set when called a second time', async () => {
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_TAGS]: ['old-tag-alpha', 'old-tag-beta'],
    });

    // Replace with completely different tags
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_TAGS]: ['new-tag-gamma'],
    });

    const modelTagRows = await db
      .select({ tagId: modelTags.tagId })
      .from(modelTags)
      .where(eq(modelTags.modelId, testModelId));

    expect(modelTagRows.length).toBe(1);

    // The surviving tag must be new-tag-gamma
    const [survivingTag] = await db
      .select()
      .from(tags)
      .where(eq(tags.id, modelTagRows[0].tagId))
      .limit(1);

    expect(survivingTag.name).toBe('new-tag-gamma');
  });
});

// ---------------------------------------------------------------------------
// Integration Tests: getModelMetadata()
// ---------------------------------------------------------------------------

describe('MetadataService – getModelMetadata()', () => {
  it('should return a uniform MetadataValue[] shape for both tags and generic fields', async () => {
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_TAGS]: ['sci-fi', 'mech'],
      [DEFAULT_SLUG_ARTIST]: 'Mixed Artist',
    });

    const values = await metadataService.getModelMetadata(testModelId);

    expect(values.length).toBe(2);

    for (const v of values) {
      expect(typeof v.fieldSlug).toBe('string');
      expect(typeof v.fieldName).toBe('string');
      expect(typeof v.type).toBe('string');
      expect(v.value).toBeDefined();
      expect(typeof v.displayValue).toBe('string');
    }
  });

  it('should return the tags MetadataValue with type multi_enum and value as string[]', async () => {
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_TAGS]: ['alpha', 'beta'],
    });

    const values = await metadataService.getModelMetadata(testModelId);
    const tagsValue = values.find((v) => v.fieldSlug === DEFAULT_SLUG_TAGS);

    expect(tagsValue).toBeDefined();
    expect(tagsValue!.type).toBe('multi_enum');
    expect(Array.isArray(tagsValue!.value)).toBe(true);
    expect((tagsValue!.value as string[]).sort()).toEqual(['alpha', 'beta'].sort());
    expect(tagsValue!.displayValue).toContain('alpha');
    expect(tagsValue!.displayValue).toContain('beta');
  });

  it('should return the artist MetadataValue with type text and value as string', async () => {
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_ARTIST]: 'Detail Artist',
    });

    const values = await metadataService.getModelMetadata(testModelId);
    const artistValue = values.find((v) => v.fieldSlug === DEFAULT_SLUG_ARTIST);

    expect(artistValue).toBeDefined();
    expect(artistValue!.type).toBe('text');
    expect(artistValue!.value).toBe('Detail Artist');
    expect(artistValue!.displayValue).toBe('Detail Artist');
  });

  it('should return an empty array when the model has no metadata', async () => {
    const values = await metadataService.getModelMetadata(testModelId);

    expect(values).toEqual([]);
  });

  it('should not include a tags entry when the model has no tags', async () => {
    // Set only a non-tag field
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_ARTIST]: 'Solo Artist',
    });

    const values = await metadataService.getModelMetadata(testModelId);
    const tagsEntry = values.find((v) => v.fieldSlug === DEFAULT_SLUG_TAGS);

    expect(tagsEntry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration Tests: Value Listing
// ---------------------------------------------------------------------------

describe('MetadataService – listFieldValues()', () => {
  it("should return tag names with model counts for the 'tags' field", async () => {
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_TAGS]: ['list-test-dragon', 'list-test-fantasy'],
    });

    const values = await metadataService.listFieldValues(DEFAULT_SLUG_TAGS);

    expect(Array.isArray(values)).toBe(true);

    const dragonEntry = values.find((v) => v.value === 'list-test-dragon');
    const fantasyEntry = values.find((v) => v.value === 'list-test-fantasy');

    expect(dragonEntry).toBeDefined();
    expect(dragonEntry!.modelCount).toBe(1);

    expect(fantasyEntry).toBeDefined();
    expect(fantasyEntry!.modelCount).toBe(1);
  });

  it('should return MetadataFieldValue[] shape with value (string) and modelCount (number)', async () => {
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_TAGS]: ['shape-check-tag'],
    });

    const values = await metadataService.listFieldValues(DEFAULT_SLUG_TAGS);
    const entry = values.find((v) => v.value === 'shape-check-tag');

    expect(entry).toBeDefined();
    expect(typeof entry!.value).toBe('string');
    expect(typeof entry!.modelCount).toBe('number');
  });

  it("should return artist values with model counts for the 'artist' field", async () => {
    await metadataService.setModelMetadata(testModelId, {
      [DEFAULT_SLUG_ARTIST]: 'Value List Artist',
    });

    const values = await metadataService.listFieldValues(DEFAULT_SLUG_ARTIST);

    expect(Array.isArray(values)).toBe(true);

    const entry = values.find((v) => v.value === 'Value List Artist');
    expect(entry).toBeDefined();
    expect(entry!.modelCount).toBe(1);
  });

  it('should throw NOT_FOUND when the field slug does not exist', async () => {
    await expect(
      metadataService.listFieldValues('ghost-field-zzz'),
    ).rejects.toThrow(AppError);

    await expect(
      metadataService.listFieldValues('ghost-field-zzz'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// Integration Tests: Bulk Operations
// ---------------------------------------------------------------------------

describe('MetadataService – bulkSetMetadata()', () => {
  it('should apply set operations to multiple models', async () => {
    // Create a second test model so we can exercise the "multiple models" path
    const [secondModel] = await db
      .insert(models)
      .values({
        name: 'Bulk Test Model B',
        slug: `bulk-test-model-b-${Date.now()}`,
        userId: testUserId,
        sourceType: 'zip_upload',
        status: 'ready',
      })
      .returning();

    try {
      await metadataService.bulkSetMetadata(
        [testModelId, secondModel.id],
        [{ fieldSlug: DEFAULT_SLUG_ARTIST, action: 'set', value: 'Bulk Artist' }],
      );

      const artistField = await metadataService.getFieldBySlug(DEFAULT_SLUG_ARTIST);

      const [meta1] = await db
        .select()
        .from(modelMetadata)
        .where(
          and(
            eq(modelMetadata.modelId, testModelId),
            eq(modelMetadata.fieldDefinitionId, artistField.id),
          ),
        )
        .limit(1);

      const [meta2] = await db
        .select()
        .from(modelMetadata)
        .where(
          and(
            eq(modelMetadata.modelId, secondModel.id),
            eq(modelMetadata.fieldDefinitionId, artistField.id),
          ),
        )
        .limit(1);

      expect(meta1?.value).toBe('Bulk Artist');
      expect(meta2?.value).toBe('Bulk Artist');
    } finally {
      // Clean up second model
      await db.delete(models).where(eq(models.id, secondModel.id));
    }
  });

  it('should apply remove operations to multiple models', async () => {
    // Create a second test model
    const [secondModel] = await db
      .insert(models)
      .values({
        name: 'Bulk Remove Test Model',
        slug: `bulk-remove-test-${Date.now()}`,
        userId: testUserId,
        sourceType: 'zip_upload',
        status: 'ready',
      })
      .returning();

    try {
      // Set artist on both models first
      await metadataService.bulkSetMetadata(
        [testModelId, secondModel.id],
        [{ fieldSlug: DEFAULT_SLUG_ARTIST, action: 'set', value: 'Will Be Removed' }],
      );

      // Now remove it from both
      await metadataService.bulkSetMetadata(
        [testModelId, secondModel.id],
        [{ fieldSlug: DEFAULT_SLUG_ARTIST, action: 'remove' }],
      );

      const artistField = await metadataService.getFieldBySlug(DEFAULT_SLUG_ARTIST);

      const metaRows = await db
        .select()
        .from(modelMetadata)
        .where(eq(modelMetadata.fieldDefinitionId, artistField.id));

      // Neither model should have the artist metadata row
      const relevantRows = metaRows.filter(
        (r) => r.modelId === testModelId || r.modelId === secondModel.id,
      );
      expect(relevantRows.length).toBe(0);
    } finally {
      await db.delete(models).where(eq(models.id, secondModel.id));
    }
  });

  it('should apply tag operations across multiple models', async () => {
    const [secondModel] = await db
      .insert(models)
      .values({
        name: 'Bulk Tag Test Model',
        slug: `bulk-tag-test-${Date.now()}`,
        userId: testUserId,
        sourceType: 'zip_upload',
        status: 'ready',
      })
      .returning();

    try {
      await metadataService.bulkSetMetadata(
        [testModelId, secondModel.id],
        [
          {
            fieldSlug: DEFAULT_SLUG_TAGS,
            action: 'set',
            value: ['bulk-applied-tag'],
          },
        ],
      );

      const modelOneTagRows = await db
        .select()
        .from(modelTags)
        .where(eq(modelTags.modelId, testModelId));

      const modelTwoTagRows = await db
        .select()
        .from(modelTags)
        .where(eq(modelTags.modelId, secondModel.id));

      expect(modelOneTagRows.length).toBe(1);
      expect(modelTwoTagRows.length).toBe(1);
    } finally {
      await db.delete(modelTags).where(eq(modelTags.modelId, secondModel.id));
      await db.delete(models).where(eq(models.id, secondModel.id));
    }
  });
});
