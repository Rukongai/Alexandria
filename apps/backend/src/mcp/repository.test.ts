import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../db/index.js';
import {
  collectionModels,
  collections,
  libraries,
  metadataFieldDefinitions,
  modelFiles,
  modelFolders,
  modelMetadata,
  models,
  modelTags,
  tags,
  thumbnails,
  users,
} from '../db/schema/index.js';
import { libraryService } from '../services/library.service.js';
import { modelService } from '../services/model.service.js';
import { searchService } from '../services/search.service.js';
import { storageService } from '../services/storage.service.js';
import { rawModelRepository } from './repository.js';
import {
  createAlexandriaMcpHandlers,
  type McpDependencies,
} from './tools.js';

const fixture = {
  userIds: [] as string[],
  libraryIds: [] as string[],
  modelIds: [] as string[],
  collectionId: '',
  tagId: '',
  fieldDefinitionId: '',
};

let ownedModelRow: typeof models.$inferSelect;
let modelFileRow: typeof modelFiles.$inferSelect;
let modelFolderRow: typeof modelFolders.$inferSelect;
let metadataRow: typeof modelMetadata.$inferSelect;
let fieldDefinitionRow: typeof metadataFieldDefinitions.$inferSelect;
let tagRow: typeof tags.$inferSelect;
let tagMembershipRow: typeof modelTags.$inferSelect;
let collectionRow: typeof collections.$inferSelect;
let collectionMembershipRow: typeof collectionModels.$inferSelect;
let thumbnailRow: typeof thumbnails.$inferSelect;
let handlers: Awaited<ReturnType<typeof createAlexandriaMcpHandlers>>['handlers'];
let relatedRowsSpy: ReturnType<typeof vi.fn<McpDependencies['rawModels']['getRelatedModelInformation']>>;
let uniqueSearchTerm: string;

beforeAll(async () => {
  const unique = randomUUID().replaceAll('-', '');
  uniqueSearchTerm = `mcpraw${unique}`;
  const modelCreatedAt = new Date('2026-04-01T01:02:03.456Z');
  const modelUpdatedAt = new Date('2026-04-02T02:03:04.567Z');
  const relatedCreatedAt = new Date('2026-04-03T03:04:05.678Z');

  const [owner, outsider] = await db.insert(users).values([
    {
      email: `mcp-raw-owner-${unique}@example.com`,
      displayName: 'MCP Raw Owner',
      passwordHash: 'not-used-by-this-test',
      role: 'admin',
    },
    {
      email: `mcp-raw-outsider-${unique}@example.com`,
      displayName: 'MCP Raw Outsider',
      passwordHash: 'not-used-by-this-test',
      role: 'user',
    },
  ]).returning();
  fixture.userIds.push(owner.id, outsider.id);

  const [ownedLibrary, foreignLibrary] = await db.insert(libraries).values([
    {
      name: 'MCP Raw Owned Library',
      slug: `mcp-raw-owned-library-${unique}`,
      userId: owner.id,
      isDefault: true,
      color: 'plum',
    },
    {
      name: 'MCP Raw Foreign Library',
      slug: `mcp-raw-foreign-library-${unique}`,
      userId: outsider.id,
      isDefault: true,
      color: 'sage',
    },
  ]).returning();
  fixture.libraryIds.push(ownedLibrary.id, foreignLibrary.id);

  const [insertedOwnedModel, foreignModel] = await db.insert(models).values([
    {
      name: `${uniqueSearchTerm} complete raw model`,
      slug: `mcp-raw-owned-model-${unique}`,
      description: 'Description retained in raw output',
      userId: owner.id,
      libraryId: ownedLibrary.id,
      sourceType: 'archive_upload',
      status: 'ready',
      originalFilename: 'source-archive.7z',
      totalSizeBytes: 9_876_543,
      fileCount: 1,
      previewCropX: 12.5,
      previewCropY: 77.25,
      previewCropScale: 1.75,
      createdAt: modelCreatedAt,
      updatedAt: modelUpdatedAt,
    },
    {
      name: `${uniqueSearchTerm} foreign raw model`,
      slug: `mcp-raw-foreign-model-${unique}`,
      userId: outsider.id,
      libraryId: foreignLibrary.id,
      sourceType: 'manual',
      status: 'ready',
      createdAt: modelCreatedAt,
      updatedAt: modelUpdatedAt,
    },
  ]).returning();
  fixture.modelIds.push(insertedOwnedModel.id, foreignModel.id);

  [modelFileRow] = await db.insert(modelFiles).values({
    modelId: insertedOwnedModel.id,
    filename: 'render.png',
    relativePath: 'private/source/render.png',
    fileType: 'image',
    mimeType: 'image/png',
    sizeBytes: 9_876_543,
    storagePath: `models/${insertedOwnedModel.id}/opaque-storage-key.bin`,
    hash: 'a'.repeat(64),
    createdAt: relatedCreatedAt,
  }).returning();

  [ownedModelRow] = await db.update(models)
    .set({ previewImageFileId: modelFileRow.id })
    .where(eq(models.id, insertedOwnedModel.id))
    .returning();

  [modelFolderRow] = await db.insert(modelFolders).values({
    modelId: insertedOwnedModel.id,
    path: 'private/empty-folder',
    createdAt: relatedCreatedAt,
  }).returning();

  [fieldDefinitionRow] = await db.insert(metadataFieldDefinitions).values({
    name: 'MCP Raw Internal Metadata',
    slug: `mcp-raw-internal-${unique}`,
    type: 'text',
    isDefault: false,
    isFilterable: true,
    isBrowsable: false,
    config: { displayHint: 'multiline', internalOption: true },
    sortOrder: 419,
    createdAt: relatedCreatedAt,
  }).returning();
  fixture.fieldDefinitionId = fieldDefinitionRow.id;

  [metadataRow] = await db.insert(modelMetadata).values({
    modelId: insertedOwnedModel.id,
    fieldDefinitionId: fieldDefinitionRow.id,
    value: 'unrendered raw metadata value',
  }).returning();

  [tagRow] = await db.insert(tags).values({
    name: `MCP Raw Tag ${unique}`,
    slug: `mcp-raw-tag-${unique}`,
  }).returning();
  fixture.tagId = tagRow.id;
  [tagMembershipRow] = await db.insert(modelTags).values({
    modelId: insertedOwnedModel.id,
    tagId: tagRow.id,
  }).returning();

  [collectionRow] = await db.insert(collections).values({
    name: 'MCP Raw Collection',
    slug: `mcp-raw-collection-${unique}`,
    description: 'Raw collection description',
    userId: owner.id,
    libraryId: ownedLibrary.id,
    createdAt: relatedCreatedAt,
    updatedAt: relatedCreatedAt,
  }).returning();
  fixture.collectionId = collectionRow.id;
  [collectionMembershipRow] = await db.insert(collectionModels).values({
    collectionId: collectionRow.id,
    modelId: insertedOwnedModel.id,
  }).returning();

  [thumbnailRow] = await db.insert(thumbnails).values({
    sourceFileId: modelFileRow.id,
    storagePath: `thumbnails/${insertedOwnedModel.id}/private-preview.webp`,
    width: 613,
    height: 487,
    format: 'webp',
    createdAt: relatedCreatedAt,
  }).returning();

  relatedRowsSpy = vi.fn(
    rawModelRepository.getRelatedModelInformation.bind(rawModelRepository),
  );
  const dependencies: McpDependencies = {
    bulk: {
      deleteModels: vi.fn(),
      setMetadata: vi.fn(),
    },
    database: { transaction: db.transaction.bind(db) },
    library: libraryService,
    model: modelService,
    metadata: {
      getFieldBySlug: vi.fn(),
      normalizeAndValidateFieldValue: vi.fn(),
      getModelMetadata: vi.fn(),
      setModelMetadata: vi.fn(),
    },
    search: searchService,
    storage: { retrieveStream: vi.fn(async () => Readable.from([])) },
    rawModels: { getRelatedModelInformation: relatedRowsSpy },
  };

  ({ handlers } = await createAlexandriaMcpHandlers({
    userId: owner.id,
    libraryId: ownedLibrary.id,
  }, dependencies));
});

afterAll(async () => {
  if (fixture.modelIds.length > 0) {
    await db.delete(models).where(inArray(models.id, fixture.modelIds));
  }
  if (fixture.collectionId) {
    await db.delete(collections).where(eq(collections.id, fixture.collectionId));
  }
  if (fixture.tagId) {
    await db.delete(tags).where(eq(tags.id, fixture.tagId));
  }
  if (fixture.fieldDefinitionId) {
    await db.delete(metadataFieldDefinitions)
      .where(eq(metadataFieldDefinitions.id, fixture.fieldDefinitionId));
  }
  if (fixture.libraryIds.length > 0) {
    await db.delete(libraries).where(inArray(libraries.id, fixture.libraryIds));
  }
  if (fixture.userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, fixture.userIds));
  }
});

describe('raw MCP model repository integration', () => {
  it('captures model-file and thumbnail storage objects for destructive cleanup', async () => {
    await expect(modelService.listModelStoragePaths([ownedModelRow.id]))
      .resolves.toEqual([modelFileRow.storagePath, thumbnailRow.storagePath].sort());
  });

  it('lists raw model-file rows in relative-path order', async () => {
    const unique = randomUUID().replaceAll('-', '');
    const [orderedModel] = await db.insert(models).values({
      name: 'MCP ordered file list',
      slug: `mcp-ordered-file-list-${unique}`,
      userId: fixture.userIds[0],
      libraryId: fixture.libraryIds[0],
      sourceType: 'manual',
      status: 'ready',
    }).returning();
    fixture.modelIds.push(orderedModel.id);

    await db.insert(modelFiles).values([
      {
        modelId: orderedModel.id,
        filename: 'z.stl',
        relativePath: 'parts/z.stl',
        fileType: 'stl',
        mimeType: 'model/stl',
        sizeBytes: 2,
        storagePath: `models/${orderedModel.id}/parts/z.stl`,
        hash: 'c'.repeat(64),
      },
      {
        modelId: orderedModel.id,
        filename: 'a.stl',
        relativePath: 'parts/a.stl',
        fileType: 'stl',
        mimeType: 'model/stl',
        sizeBytes: 1,
        storagePath: `models/${orderedModel.id}/parts/a.stl`,
        hash: 'b'.repeat(64),
      },
    ]);

    const result = await handlers.getModelFiles({ modelId: orderedModel.id });

    expect(result.fileCount).toBe(2);
    expect(result.files.map((file) => file.relativePath)).toEqual([
      'parts/a.stl',
      'parts/z.stl',
    ]);
  });

  it('returns complete model and related table rows after enforcing ownership scope', async () => {
    const result = await handlers.getModel({ modelId: ownedModelRow.id });

    expect(result.model).toEqual(ownedModelRow);
    expect(result.modelFiles).toEqual([modelFileRow]);
    expect(result.modelFolders).toEqual([modelFolderRow]);
    expect(result.metadata).toEqual([{
      modelMetadata: metadataRow,
      fieldDefinition: fieldDefinitionRow,
    }]);
    expect(result.tags).toEqual({
      rows: [tagRow],
      memberships: [tagMembershipRow],
    });
    expect(result.collections).toEqual({
      rows: [collectionRow],
      memberships: [collectionMembershipRow],
    });
    expect(result.thumbnails).toEqual([thumbnailRow]);

    expect(result.modelFiles[0]).toMatchObject({
      id: modelFileRow.id,
      modelId: ownedModelRow.id,
      hash: 'a'.repeat(64),
      storagePath: modelFileRow.storagePath,
      createdAt: modelFileRow.createdAt,
    });
    expect(result.thumbnails[0]).toMatchObject({
      id: thumbnailRow.id,
      sourceFileId: modelFileRow.id,
      storagePath: thumbnailRow.storagePath,
      createdAt: thumbnailRow.createdAt,
    });
  });

  it('does not query related rows for a model outside the configured user and library', async () => {
    relatedRowsSpy.mockClear();

    await expect(handlers.getModel({ modelId: fixture.modelIds[1] }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(relatedRowsSpy).not.toHaveBeenCalled();
  });

  it('hydrates real scoped search results with complete raw model rows', async () => {
    const result = await handlers.searchModels({ q: uniqueSearchTerm, pageSize: 20 });
    const rawModels = result.models as Array<Record<string, unknown>>;

    expect(result.total).toBe(1);
    expect(rawModels).toEqual([ownedModelRow]);
    expect(rawModels[0]).toMatchObject({
      userId: fixture.userIds[0],
      libraryId: fixture.libraryIds[0],
      originalFilename: 'source-archive.7z',
      description: 'Description retained in raw output',
      previewImageFileId: modelFileRow.id,
      previewCropX: 12.5,
      previewCropY: 77.25,
      previewCropScale: 1.75,
    });
  });

  it('rolls back database changes and removes staged objects when merge commit fails', async () => {
    const unique = randomUUID().replaceAll('-', '');
    const [target, source] = await db.insert(models).values([
      {
        name: 'Merge rollback target',
        slug: `merge-rollback-target-${unique}`,
        userId: fixture.userIds[0],
        libraryId: fixture.libraryIds[0],
        sourceType: 'manual',
        status: 'ready',
      },
      {
        name: 'Merge rollback source',
        slug: `merge-rollback-source-${unique}`,
        userId: fixture.userIds[0],
        libraryId: fixture.libraryIds[0],
        sourceType: 'manual',
        status: 'ready',
      },
    ]).returning();
    const originalStoragePath = `models/${source.id}/part.stl`;
    const [file] = await db.insert(modelFiles).values({
      modelId: source.id,
      filename: 'part.stl',
      relativePath: 'part.stl',
      fileType: 'stl',
      mimeType: 'model/stl',
      sizeBytes: 42,
      storagePath: originalStoragePath,
      hash: 'b'.repeat(64),
    }).returning();
    const copySpy = vi.spyOn(storageService, 'copy').mockResolvedValue(undefined);
    const deleteSpy = vi.spyOn(storageService, 'delete').mockResolvedValue(undefined);
    const recalculateSpy = vi.spyOn(modelService, 'recalculateModelStats')
      .mockRejectedValueOnce(new Error('forced transaction failure'));

    try {
      await expect(modelService.mergeModels(
        target.id,
        [source.id],
        fixture.userIds[0],
        fixture.libraryIds[0],
      )).rejects.toThrow('forced transaction failure');

      const [sourceAfter] = await db.select().from(models).where(eq(models.id, source.id));
      const [fileAfter] = await db.select().from(modelFiles).where(eq(modelFiles.id, file.id));
      expect(sourceAfter?.id).toBe(source.id);
      expect(fileAfter).toMatchObject({
        modelId: source.id,
        relativePath: 'part.stl',
        storagePath: originalStoragePath,
      });
      expect(copySpy).toHaveBeenCalledTimes(2);
      expect(deleteSpy.mock.calls.map(([storagePath]) => storagePath)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('merge-staging/'),
          `models/${target.id}/part.stl`,
        ]),
      );
    } finally {
      recalculateSpy.mockRestore();
      copySpy.mockRestore();
      deleteSpy.mockRestore();
      await db.delete(models).where(inArray(models.id, [target.id, source.id]));
    }
  });

  it('serializes competing merges over the same source model', async () => {
    const unique = randomUUID().replaceAll('-', '');
    const [targetA, targetB, source] = await db.insert(models).values([
      {
        name: 'Concurrent merge target A',
        slug: `concurrent-merge-target-a-${unique}`,
        userId: fixture.userIds[0],
        libraryId: fixture.libraryIds[0],
        sourceType: 'manual',
        status: 'ready',
      },
      {
        name: 'Concurrent merge target B',
        slug: `concurrent-merge-target-b-${unique}`,
        userId: fixture.userIds[0],
        libraryId: fixture.libraryIds[0],
        sourceType: 'manual',
        status: 'ready',
      },
      {
        name: 'Concurrent merge source',
        slug: `concurrent-merge-source-${unique}`,
        userId: fixture.userIds[0],
        libraryId: fixture.libraryIds[0],
        sourceType: 'manual',
        status: 'ready',
      },
    ]).returning();
    const [file] = await db.insert(modelFiles).values({
      modelId: source.id,
      filename: 'part.stl',
      relativePath: 'part.stl',
      fileType: 'stl',
      mimeType: 'model/stl',
      sizeBytes: 42,
      storagePath: `models/${source.id}/part.stl`,
      hash: 'c'.repeat(64),
    }).returning();
    const copySpy = vi.spyOn(storageService, 'copy').mockResolvedValue(undefined);
    const deleteSpy = vi.spyOn(storageService, 'delete').mockResolvedValue(undefined);

    try {
      const outcomes = await Promise.allSettled([
        modelService.mergeModels(
          targetA.id,
          [source.id],
          fixture.userIds[0],
          fixture.libraryIds[0],
        ),
        modelService.mergeModels(
          targetB.id,
          [source.id],
          fixture.userIds[0],
          fixture.libraryIds[0],
        ),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      const [fileAfter] = await db.select().from(modelFiles).where(eq(modelFiles.id, file.id));
      expect([targetA.id, targetB.id]).toContain(fileAfter.modelId);
      await expect(db.select().from(models).where(eq(models.id, source.id))).resolves.toEqual([]);
    } finally {
      copySpy.mockRestore();
      deleteSpy.mockRestore();
      await db.delete(models).where(inArray(models.id, [targetA.id, targetB.id, source.id]));
    }
  });
});
