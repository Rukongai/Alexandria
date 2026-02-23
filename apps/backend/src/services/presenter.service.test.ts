import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  users,
  models,
  modelFiles,
  thumbnails,
  tags,
  modelTags,
  collections,
  collectionModels,
  modelMetadata,
  metadataFieldDefinitions,
} from '../db/schema/index.js';
import { presenterService } from './presenter.service.js';
import { formatDisplayValue } from '../utils/format.js';
import type { FileTreeNode } from '@alexandria/shared';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let testUserId: string;
let testModelId: string;
let imageFileId: string;
let gridThumbnailId: string;
let detailThumbnailId: string;
let collectionId: string;
let artistFieldId: string;

beforeAll(async () => {
  // Cleanup leftovers
  const leftoverUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'presenter-test@example.com'));
  if (leftoverUsers.length > 0) {
    const ids = leftoverUsers.map((u) => u.id);
    await db.delete(collections).where(inArray(collections.userId, ids));
    await db.delete(models).where(inArray(models.userId, ids));
    await db.delete(users).where(eq(users.email, 'presenter-test@example.com'));
  }
  await db.delete(tags).where(eq(tags.name, 'PresenterTestTag'));

  // Create test user
  const [user] = await db
    .insert(users)
    .values({
      email: 'presenter-test@example.com',
      displayName: 'Presenter Test User',
      passwordHash: 'not-a-real-hash',
      role: 'admin',
    })
    .returning();
  testUserId = user.id;

  // Create test model
  const [model] = await db
    .insert(models)
    .values({
      name: 'Presenter Test Model',
      slug: `presenter-test-model-${Date.now()}`,
      description: 'A test model for presenter service',
      userId: testUserId,
      sourceType: 'zip_upload',
      status: 'ready',
      totalSizeBytes: 5000,
      fileCount: 3,
    })
    .returning();
  testModelId = model.id;

  // Create model files: image, stl, document
  const [imgFile] = await db
    .insert(modelFiles)
    .values({
      modelId: testModelId,
      filename: 'render.png',
      relativePath: 'images/render.png',
      fileType: 'image',
      mimeType: 'image/png',
      sizeBytes: 2000,
      storagePath: `models/${testModelId}/images/render.png`,
      hash: 'abc123',
    })
    .returning();
  imageFileId = imgFile.id;

  await db.insert(modelFiles).values({
    modelId: testModelId,
    filename: 'model.stl',
    relativePath: 'model.stl',
    fileType: 'stl',
    mimeType: 'model/stl',
    sizeBytes: 2500,
    storagePath: `models/${testModelId}/model.stl`,
    hash: 'def456',
  });

  await db.insert(modelFiles).values({
    modelId: testModelId,
    filename: 'readme.txt',
    relativePath: 'docs/readme.txt',
    fileType: 'document',
    mimeType: 'text/plain',
    sizeBytes: 500,
    storagePath: `models/${testModelId}/docs/readme.txt`,
    hash: 'ghi789',
  });

  // Create thumbnails for the image file
  const [gridThumb] = await db
    .insert(thumbnails)
    .values({
      sourceFileId: imageFileId,
      storagePath: `thumbnails/${testModelId}/${imageFileId}_grid.webp`,
      width: 400,
      height: 400,
      format: 'webp',
    })
    .returning();
  gridThumbnailId = gridThumb.id;

  const [detailThumb] = await db
    .insert(thumbnails)
    .values({
      sourceFileId: imageFileId,
      storagePath: `thumbnails/${testModelId}/${imageFileId}_detail.webp`,
      width: 800,
      height: 800,
      format: 'webp',
    })
    .returning();
  detailThumbnailId = detailThumb.id;

  // Create a collection and add the model
  const [coll] = await db
    .insert(collections)
    .values({
      name: 'Presenter Test Collection',
      slug: `presenter-test-collection-${Date.now()}`,
      userId: testUserId,
    })
    .returning();
  collectionId = coll.id;

  await db.insert(collectionModels).values({
    collectionId,
    modelId: testModelId,
  });

  // Add metadata: artist + tags
  const [artistField] = await db
    .select({ id: metadataFieldDefinitions.id })
    .from(metadataFieldDefinitions)
    .where(eq(metadataFieldDefinitions.slug, 'artist'));
  artistFieldId = artistField.id;

  await db.insert(modelMetadata).values({
    modelId: testModelId,
    fieldDefinitionId: artistFieldId,
    value: 'TestArtist',
  });

  const [tag] = await db
    .insert(tags)
    .values({ name: 'PresenterTestTag', slug: `presenter-test-tag-${Date.now()}` })
    .returning();

  await db.insert(modelTags).values({
    modelId: testModelId,
    tagId: tag.id,
  });
});

afterAll(async () => {
  await db.delete(collections).where(eq(collections.id, collectionId));
  await db.delete(models).where(eq(models.id, testModelId));
  await db.delete(tags).where(eq(tags.name, 'PresenterTestTag'));
  await db.delete(users).where(eq(users.id, testUserId));
});

// ---------------------------------------------------------------------------
// formatDisplayValue
// ---------------------------------------------------------------------------

describe('formatDisplayValue', () => {
  it('should format boolean true as "Yes"', () => {
    expect(formatDisplayValue('boolean', 'true')).toBe('Yes');
  });

  it('should format boolean false as "No"', () => {
    expect(formatDisplayValue('boolean', 'false')).toBe('No');
  });

  it('should join arrays with comma and space', () => {
    expect(formatDisplayValue('multi_enum', ['a', 'b', 'c'])).toBe('a, b, c');
  });

  it('should return string values as-is for text type', () => {
    expect(formatDisplayValue('text', 'hello')).toBe('hello');
  });

  it('should return string values as-is for number type', () => {
    expect(formatDisplayValue('number', '42')).toBe('42');
  });
});

// ---------------------------------------------------------------------------
// buildFileTree
// ---------------------------------------------------------------------------

describe('buildFileTree', () => {
  it('should build nested tree from flat relative paths', () => {
    const files = [
      { id: '1', filename: 'render.png', relativePath: 'images/render.png', fileType: 'image', sizeBytes: 2000 },
      { id: '2', filename: 'model.stl', relativePath: 'model.stl', fileType: 'stl', sizeBytes: 3000 },
      { id: '3', filename: 'readme.txt', relativePath: 'docs/readme.txt', fileType: 'document', sizeBytes: 500 },
    ];

    const tree = presenterService.buildFileTree(files);

    // Should have 3 top-level items: 2 directories + 1 file
    expect(tree.length).toBe(3);

    // Directories first (sorted), then files
    expect(tree[0].name).toBe('docs');
    expect(tree[0].type).toBe('directory');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children![0].name).toBe('readme.txt');

    expect(tree[1].name).toBe('images');
    expect(tree[1].type).toBe('directory');
    expect(tree[1].children).toHaveLength(1);
    expect(tree[1].children![0].name).toBe('render.png');

    expect(tree[2].name).toBe('model.stl');
    expect(tree[2].type).toBe('file');
    expect(tree[2].fileType).toBe('stl');
    expect(tree[2].sizeBytes).toBe(3000);
    expect(tree[2].id).toBe('2');
  });

  it('should handle deeply nested paths', () => {
    const files = [
      { id: '1', filename: 'file.stl', relativePath: 'a/b/c/file.stl', fileType: 'stl', sizeBytes: 100 },
    ];

    const tree = presenterService.buildFileTree(files);

    expect(tree[0].name).toBe('a');
    expect(tree[0].children![0].name).toBe('b');
    expect(tree[0].children![0].children![0].name).toBe('c');
    expect(tree[0].children![0].children![0].children![0].name).toBe('file.stl');
  });

  it('should return empty array for empty input', () => {
    expect(presenterService.buildFileTree([])).toEqual([]);
  });

  it('should sort directories before files', () => {
    const files = [
      { id: '1', filename: 'z.stl', relativePath: 'z.stl', fileType: 'stl', sizeBytes: 100 },
      { id: '2', filename: 'a.png', relativePath: 'folder/a.png', fileType: 'image', sizeBytes: 200 },
      { id: '3', filename: 'a.stl', relativePath: 'a.stl', fileType: 'stl', sizeBytes: 300 },
    ];

    const tree = presenterService.buildFileTree(files);

    expect(tree[0].type).toBe('directory');
    expect(tree[0].name).toBe('folder');
    expect(tree[1].type).toBe('file');
    expect(tree[1].name).toBe('a.stl');
    expect(tree[2].type).toBe('file');
    expect(tree[2].name).toBe('z.stl');
  });
});

// ---------------------------------------------------------------------------
// buildModelCard
// ---------------------------------------------------------------------------

describe('buildModelCard', () => {
  it('should return a properly shaped ModelCard', async () => {
    const card = await presenterService.buildModelCard(testModelId);

    expect(card.id).toBe(testModelId);
    expect(card.name).toBe('Presenter Test Model');
    expect(card.status).toBe('ready');
    expect(card.fileCount).toBe(3);
    expect(card.totalSizeBytes).toBe(5000);
    expect(typeof card.createdAt).toBe('string');
    expect(card.thumbnailUrl).toBe(`/files/thumbnails/${gridThumbnailId}.webp`);
  });

  it('should include metadata in the ModelCard', async () => {
    const card = await presenterService.buildModelCard(testModelId);

    const artistMeta = card.metadata.find((m) => m.fieldSlug === 'artist');
    expect(artistMeta).toBeDefined();
    expect(artistMeta!.value).toBe('TestArtist');

    const tagsMeta = card.metadata.find((m) => m.fieldSlug === 'tags');
    expect(tagsMeta).toBeDefined();
    expect(tagsMeta!.type).toBe('multi_enum');
    expect(Array.isArray(tagsMeta!.value)).toBe(true);
    expect(tagsMeta!.value).toContain('PresenterTestTag');
  });
});

// ---------------------------------------------------------------------------
// buildModelDetail
// ---------------------------------------------------------------------------

describe('buildModelDetail', () => {
  it('should return a properly shaped ModelDetail', async () => {
    const detail = await presenterService.buildModelDetail(testModelId);

    expect(detail.id).toBe(testModelId);
    expect(detail.name).toBe('Presenter Test Model');
    expect(detail.description).toBe('A test model for presenter service');
    expect(detail.sourceType).toBe('zip_upload');
    expect(detail.status).toBe('ready');
    expect(detail.fileCount).toBe(3);
    expect(detail.totalSizeBytes).toBe(5000);
    expect(typeof detail.createdAt).toBe('string');
    expect(typeof detail.updatedAt).toBe('string');
  });

  it('should include collections the model belongs to', async () => {
    const detail = await presenterService.buildModelDetail(testModelId);

    expect(detail.collections).toHaveLength(1);
    expect(detail.collections[0].id).toBe(collectionId);
    expect(detail.collections[0].name).toBe('Presenter Test Collection');
  });

  it('should include image files with thumbnail and original URLs', async () => {
    const detail = await presenterService.buildModelDetail(testModelId);

    expect(detail.images).toHaveLength(1);
    expect(detail.images[0].id).toBe(imageFileId);
    expect(detail.images[0].filename).toBe('render.png');
    expect(detail.images[0].thumbnailUrl).toBe(`/files/thumbnails/${detailThumbnailId}.webp`);
    expect(detail.images[0].originalUrl).toBe(`/files/models/${testModelId}/images/render.png`);
  });

  it('should resolve thumbnailUrl from grid-size thumbnail', async () => {
    const detail = await presenterService.buildModelDetail(testModelId);

    expect(detail.thumbnailUrl).toBe(`/files/thumbnails/${gridThumbnailId}.webp`);
  });

  it('should include metadata with artist and tags', async () => {
    const detail = await presenterService.buildModelDetail(testModelId);

    const artistMeta = detail.metadata.find((m) => m.fieldSlug === 'artist');
    expect(artistMeta).toBeDefined();
    expect(artistMeta!.value).toBe('TestArtist');

    const tagsMeta = detail.metadata.find((m) => m.fieldSlug === 'tags');
    expect(tagsMeta).toBeDefined();
    expect(tagsMeta!.value).toContain('PresenterTestTag');
  });
});

// ---------------------------------------------------------------------------
// buildModelCardsFromRows
// ---------------------------------------------------------------------------

describe('buildModelCardsFromRows', () => {
  it('should return empty array for empty input', async () => {
    const cards = await presenterService.buildModelCardsFromRows([], []);
    expect(cards).toEqual([]);
  });

  it('should assemble cards in the same order as input rows', async () => {
    const rows = [
      {
        id: testModelId,
        name: 'Presenter Test Model',
        slug: 'test',
        status: 'ready',
        fileCount: 3,
        totalSizeBytes: 5000,
        createdAt: new Date(),
      },
    ];

    const cards = await presenterService.buildModelCardsFromRows(rows, [testModelId]);

    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe(testModelId);
    expect(cards[0].thumbnailUrl).toBe(`/files/thumbnails/${gridThumbnailId}.webp`);
    expect(cards[0].metadata.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildCollectionDetail — delegates to CollectionService
// ---------------------------------------------------------------------------

describe('buildCollectionDetail', () => {
  it('should return CollectionDetail shape', async () => {
    const detail = await presenterService.buildCollectionDetail(collectionId);

    expect(detail.id).toBe(collectionId);
    expect(detail.name).toBe('Presenter Test Collection');
    expect(typeof detail.modelCount).toBe('number');
    expect(detail.modelCount).toBe(1);
    expect(Array.isArray(detail.children)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildMetadataFieldList — delegates to MetadataService
// ---------------------------------------------------------------------------

describe('buildMetadataFieldList', () => {
  it('should return array of MetadataFieldDetail', async () => {
    const fields = await presenterService.buildMetadataFieldList();

    expect(Array.isArray(fields)).toBe(true);
    expect(fields.length).toBeGreaterThan(0);

    // Default fields should be present
    const artistField = fields.find((f) => f.slug === 'artist');
    expect(artistField).toBeDefined();
    expect(artistField!.type).toBe('text');
    expect(artistField!.isDefault).toBe(true);
  });
});
