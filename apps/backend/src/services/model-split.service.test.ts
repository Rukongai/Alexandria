import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

const storageMocks = vi.hoisted(() => ({
  copy: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('./storage.service.js', () => ({
  storageService: {
    copy: storageMocks.copy,
    delete: storageMocks.delete,
  },
}));

import { db } from '../db/index.js';
import {
  libraries,
  metadataFieldDefinitions,
  modelFiles,
  modelFolders,
  modelMetadata,
  modelTags,
  models,
  tags,
  thumbnails,
  users,
} from '../db/schema/index.js';
import { ModelService } from './model.service.js';

const TEST_EMAIL = 'model-split-test@example.com';
const service = new ModelService();

let userId: string;
let libraryId: string;
let sourceModelId: string;
let imageFileId: string;

async function deleteTestUser(): Promise<void> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, TEST_EMAIL));
  if (rows.length === 0) return;
  const userIds = rows.map((row) => row.id);
  await db.delete(models).where(inArray(models.userId, userIds));
  await db.delete(libraries).where(inArray(libraries.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
}

beforeAll(async () => {
  await deleteTestUser();
  const [user] = await db.insert(users).values({
    email: TEST_EMAIL,
    displayName: 'Model Split Test',
    passwordHash: 'not-a-real-hash',
    role: 'admin',
  }).returning();
  userId = user.id;

  const [library] = await db.insert(libraries).values({
    name: 'Model Split Library',
    slug: `model-split-library-${Date.now()}`,
    userId,
    isDefault: true,
  }).returning();
  libraryId = library.id;
});

beforeEach(async () => {
  vi.clearAllMocks();
  storageMocks.copy.mockResolvedValue(undefined);
  storageMocks.delete.mockResolvedValue(undefined);

  const [source] = await db.insert(models).values({
    name: 'Source Model',
    slug: `model-split-source-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    userId,
    libraryId,
    sourceType: 'archive_upload',
    status: 'ready',
    fileCount: 3,
    totalSizeBytes: 600,
  }).returning();
  sourceModelId = source.id;

  await db.insert(modelFolders).values([
    { modelId: sourceModelId, path: 'bundle' },
    { modelId: sourceModelId, path: 'bundle/nested' },
    { modelId: sourceModelId, path: 'outside-empty' },
  ]);

  const [image] = await db.insert(modelFiles).values({
    modelId: sourceModelId,
    filename: 'cover.png',
    relativePath: 'bundle/cover.png',
    fileType: 'image',
    mimeType: 'image/png',
    sizeBytes: 100,
    storagePath: `models/${sourceModelId}/bundle/cover.png`,
    hash: 'image-hash',
  }).returning();
  imageFileId = image.id;

  await db.insert(modelFiles).values([
    {
      modelId: sourceModelId,
      filename: 'part.stl',
      relativePath: 'bundle/nested/part.stl',
      fileType: 'stl',
      mimeType: 'model/stl',
      sizeBytes: 200,
      storagePath: `models/${sourceModelId}/bundle/nested/part.stl`,
      hash: 'part-hash',
    },
    {
      modelId: sourceModelId,
      filename: 'keep.stl',
      relativePath: 'keep.stl',
      fileType: 'stl',
      mimeType: 'model/stl',
      sizeBytes: 300,
      storagePath: `models/${sourceModelId}/keep.stl`,
      hash: 'keep-hash',
    },
  ]);

  await db.insert(thumbnails).values({
    sourceFileId: imageFileId,
    storagePath: `thumbnails/${sourceModelId}/${imageFileId}_grid.webp`,
    width: 400,
    height: 400,
    format: 'webp',
  });

  await db.update(models).set({
    previewImageFileId: imageFileId,
    previewCropX: 25,
    previewCropY: 75,
    previewCropScale: 1.5,
  }).where(eq(models.id, sourceModelId));
});

afterEach(async () => {
  await db.delete(models).where(eq(models.userId, userId));
});

afterAll(async () => {
  await deleteTestUser();
});

describe('ModelService – splitModelFolder', () => {
  it('should move a folder into a new model root and preserve its preview', async () => {
    const result = await service.splitModelFolder(
      sourceModelId,
      'bundle',
      'Separated Bundle',
      userId,
      libraryId,
    );

    expect(result).toEqual({
      sourceModelId,
      newModelId: expect.any(String),
      movedFileCount: 2,
    });

    const [source, created] = await Promise.all([
      service.getModelById(sourceModelId),
      service.getModelById(result.newModelId),
    ]);
    expect(source).toMatchObject({
      fileCount: 1,
      totalSizeBytes: 300,
      previewImageFileId: null,
      previewCropX: null,
      previewCropY: null,
      previewCropScale: null,
    });
    expect(created).toMatchObject({
      name: 'Separated Bundle',
      userId,
      libraryId,
      sourceType: 'manual',
      status: 'ready',
      fileCount: 2,
      totalSizeBytes: 300,
      previewImageFileId: imageFileId,
      previewCropX: 25,
      previewCropY: 75,
      previewCropScale: 1.5,
    });

    const [sourceFiles, createdFiles, sourceFolders, createdFolders, thumbnailRows] =
      await Promise.all([
        service.getModelFiles(sourceModelId),
        service.getModelFiles(result.newModelId),
        service.getModelFolders(sourceModelId),
        service.getModelFolders(result.newModelId),
        db.select().from(thumbnails).where(eq(thumbnails.sourceFileId, imageFileId)),
      ]);
    expect(sourceFiles.map((file) => file.relativePath)).toEqual(['keep.stl']);
    expect(createdFiles.map((file) => file.relativePath)).toEqual(['cover.png', 'nested/part.stl']);
    expect(createdFiles.map((file) => file.storagePath)).toEqual([
      `models/${result.newModelId}/cover.png`,
      `models/${result.newModelId}/nested/part.stl`,
    ]);
    expect(sourceFolders.map((folder) => folder.path)).toEqual(['outside-empty']);
    expect(createdFolders.map((folder) => folder.path)).toEqual(['nested']);
    expect(thumbnailRows[0]?.storagePath).toBe(
      `thumbnails/${result.newModelId}/${imageFileId}_grid.webp`,
    );

    expect(storageMocks.copy).toHaveBeenCalledTimes(3);
    expect(storageMocks.delete).toHaveBeenCalledWith(
      `models/${sourceModelId}/bundle/cover.png`,
    );
    expect(storageMocks.delete).toHaveBeenCalledWith(
      `thumbnails/${sourceModelId}/${imageFileId}_grid.webp`,
    );
  });

  it('should move selected files into one model while preserving their relative paths', async () => {
    const [keepFile] = await db
      .select({ id: modelFiles.id })
      .from(modelFiles)
      .where(and(
        eq(modelFiles.modelId, sourceModelId),
        eq(modelFiles.relativePath, 'keep.stl'),
      ))
      .limit(1);
    if (!keepFile) throw new Error('Expected keep.stl fixture');

    const result = await service.splitModelFiles(
      sourceModelId,
      [imageFileId, keepFile.id],
      'Selected Files',
      userId,
      libraryId,
    );

    expect(result).toEqual({
      sourceModelId,
      newModelId: expect.any(String),
      movedFileCount: 2,
    });
    expect((await service.getModelFiles(sourceModelId)).map((file) => file.relativePath))
      .toEqual(['bundle/nested/part.stl']);
    expect((await service.getModelFiles(result.newModelId)).map((file) => file.relativePath))
      .toEqual(['bundle/cover.png', 'keep.stl']);
    expect(await service.getModelById(sourceModelId)).toMatchObject({
      fileCount: 1,
      totalSizeBytes: 200,
      previewImageFileId: null,
    });
    expect(await service.getModelById(result.newModelId)).toMatchObject({
      name: 'Selected Files',
      fileCount: 2,
      totalSizeBytes: 400,
      previewImageFileId: imageFileId,
    });
    expect(storageMocks.copy).toHaveBeenCalledWith(
      `models/${sourceModelId}/bundle/cover.png`,
      `models/${result.newModelId}/bundle/cover.png`,
    );
    expect(storageMocks.copy).toHaveBeenCalledWith(
      `models/${sourceModelId}/keep.stl`,
      `models/${result.newModelId}/keep.stl`,
    );
  });

  it('should reject a selected file that does not belong to the source model', async () => {
    const [otherModel] = await db.insert(models).values({
      name: 'Other Model',
      slug: `model-split-other-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      userId,
      libraryId,
      sourceType: 'manual',
      status: 'ready',
    }).returning();
    const [otherFile] = await db.insert(modelFiles).values({
      modelId: otherModel.id,
      filename: 'other.stl',
      relativePath: 'other.stl',
      fileType: 'stl',
      mimeType: 'model/stl',
      sizeBytes: 10,
      storagePath: `models/${otherModel.id}/other.stl`,
      hash: 'other-file-hash',
    }).returning();

    await expect(service.splitModelFiles(
      sourceModelId,
      [imageFileId, otherFile.id],
      'Invalid Selection',
      userId,
      libraryId,
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await db.select().from(models).where(eq(models.userId, userId))).toHaveLength(2);
    expect(storageMocks.copy).not.toHaveBeenCalled();
  });

  it('should copy only the selected metadata fields and leave source metadata intact', async () => {
    const fieldRows = await db
      .select({ id: metadataFieldDefinitions.id, slug: metadataFieldDefinitions.slug })
      .from(metadataFieldDefinitions)
      .where(inArray(metadataFieldDefinitions.slug, ['artist', 'year']));
    const fieldIds = new Map(fieldRows.map((field) => [field.slug, field.id]));
    expect(fieldIds.get('artist')).toBeDefined();
    expect(fieldIds.get('year')).toBeDefined();

    await db.insert(modelMetadata).values([
      {
        modelId: sourceModelId,
        fieldDefinitionId: fieldIds.get('artist')!,
        value: 'Alexandria Artist',
      },
      {
        modelId: sourceModelId,
        fieldDefinitionId: fieldIds.get('year')!,
        value: '2026',
      },
    ]);
    const tagSlug = `split-tag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const [tag] = await db.insert(tags).values({
      name: `Split tag ${tagSlug}`,
      slug: tagSlug,
    }).returning();
    await db.insert(modelTags).values({ modelId: sourceModelId, tagId: tag.id });

    const result = await service.splitModelFolder(
      sourceModelId,
      'bundle',
      'Metadata Copy',
      userId,
      libraryId,
      ['artist', 'tags'],
    );

    const createdMetadata = await db
      .select({ slug: metadataFieldDefinitions.slug, value: modelMetadata.value })
      .from(modelMetadata)
      .innerJoin(
        metadataFieldDefinitions,
        eq(modelMetadata.fieldDefinitionId, metadataFieldDefinitions.id),
      )
      .where(eq(modelMetadata.modelId, result.newModelId));
    const createdTags = await db
      .select({ id: modelTags.tagId })
      .from(modelTags)
      .where(eq(modelTags.modelId, result.newModelId));

    expect(createdMetadata).toEqual([{ slug: 'artist', value: 'Alexandria Artist' }]);
    expect(createdTags).toEqual([{ id: tag.id }]);
    expect(await db.select().from(modelMetadata).where(eq(modelMetadata.modelId, sourceModelId)))
      .toHaveLength(2);
    expect(await db.select().from(modelTags).where(eq(modelTags.modelId, sourceModelId)))
      .toEqual([{ modelId: sourceModelId, tagId: tag.id }]);
  });

  it('should reject a selected metadata field that no longer exists', async () => {
    await expect(service.splitModelFolder(
      sourceModelId,
      'bundle',
      'Stale Metadata Selection',
      userId,
      libraryId,
      ['deleted-field'],
    )).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'metadataFieldSlugs',
    });

    expect(await db.select().from(models).where(eq(models.userId, userId))).toHaveLength(1);
    expect(storageMocks.delete).toHaveBeenCalledTimes(3);
  });

  it('should hold selected metadata field definitions until the split commits', async () => {
    const fieldSlug = `split-lock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const [field] = await db.insert(metadataFieldDefinitions).values({
      name: 'Split Lock Field',
      slug: fieldSlug,
      type: 'text',
      isDefault: false,
      isFilterable: false,
      isBrowsable: false,
      sortOrder: 99,
    }).returning();
    const originalRecalculate = service.recalculateModelStats.bind(service);
    let releaseStats!: () => void;
    let markStatsReached!: () => void;
    const statsGate = new Promise<void>((resolve) => { releaseStats = resolve; });
    const statsReached = new Promise<void>((resolve) => { markStatsReached = resolve; });
    let pauseNextStats = true;
    const statsSpy = vi.spyOn(service, 'recalculateModelStats').mockImplementation(
      async (modelId, executor) => {
        if (pauseNextStats) {
          pauseNextStats = false;
          markStatsReached();
          await statsGate;
        }
        return originalRecalculate(modelId, executor);
      },
    );
    const splitPromise = service.splitModelFolder(
      sourceModelId,
      'bundle',
      'Locked Metadata Definition',
      userId,
      libraryId,
      [fieldSlug],
    );
    let deletionSettled = false;
    let deletionPromise: Promise<unknown> | undefined;

    try {
      await statsReached;
      deletionPromise = db
        .delete(metadataFieldDefinitions)
        .where(eq(metadataFieldDefinitions.id, field.id))
        .then((result) => {
          deletionSettled = true;
          return result;
        });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(deletionSettled).toBe(false);

      releaseStats();
      const result = await splitPromise;
      await deletionPromise;
      expect(deletionSettled).toBe(true);
      expect(await service.getModelById(result.newModelId)).toMatchObject({
        name: 'Locked Metadata Definition',
        status: 'ready',
      });
    } finally {
      releaseStats();
      statsSpy.mockRestore();
      await Promise.allSettled([
        splitPromise,
        deletionPromise ?? Promise.resolve(),
        db.delete(metadataFieldDefinitions).where(eq(metadataFieldDefinitions.id, field.id)),
      ]);
    }
  });

  it('should roll back copied metadata and clean storage when a later transaction step fails', async () => {
    const [artistField] = await db
      .select({ id: metadataFieldDefinitions.id })
      .from(metadataFieldDefinitions)
      .where(eq(metadataFieldDefinitions.slug, 'artist'))
      .limit(1);
    if (!artistField) throw new Error('Seeded artist metadata field is required');
    await db.insert(modelMetadata).values({
      modelId: sourceModelId,
      fieldDefinitionId: artistField.id,
      value: 'Rollback Artist',
    });
    const tagSlug = `rollback-tag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const [tag] = await db.insert(tags).values({
      name: `Rollback tag ${tagSlug}`,
      slug: tagSlug,
    }).returning();
    await db.insert(modelTags).values({ modelId: sourceModelId, tagId: tag.id });
    const statsSpy = vi
      .spyOn(service, 'recalculateModelStats')
      .mockRejectedValueOnce(new Error('stats failed'));

    try {
      await expect(service.splitModelFolder(
        sourceModelId,
        'bundle',
        'Rollback Metadata',
        userId,
        libraryId,
        ['artist', 'tags'],
      )).rejects.toThrow('stats failed');
    } finally {
      statsSpy.mockRestore();
    }

    expect(await db.select().from(models).where(eq(models.userId, userId))).toHaveLength(1);
    expect(await db.select().from(modelMetadata).where(eq(modelMetadata.modelId, sourceModelId)))
      .toHaveLength(1);
    expect(await db.select().from(modelTags).where(eq(modelTags.modelId, sourceModelId)))
      .toEqual([{ modelId: sourceModelId, tagId: tag.id }]);
    expect((await service.getModelFiles(sourceModelId)).map((file) => file.relativePath)).toEqual([
      'bundle/cover.png',
      'bundle/nested/part.stl',
      'keep.stl',
    ]);
    expect(storageMocks.delete).toHaveBeenCalledTimes(3);
  });

  it('should leave database state unchanged and clean copied files when a copy fails', async () => {
    storageMocks.copy
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('copy failed'));

    await expect(service.splitModelFolder(
      sourceModelId,
      'bundle',
      'Separated Bundle',
      userId,
      libraryId,
    )).rejects.toThrow('copy failed');

    const ownedModels = await db
      .select()
      .from(models)
      .where(eq(models.userId, userId));
    const sourceFiles = await service.getModelFiles(sourceModelId);
    expect(ownedModels).toHaveLength(1);
    expect(sourceFiles.map((file) => file.relativePath)).toEqual([
      'bundle/cover.png',
      'bundle/nested/part.stl',
      'keep.stl',
    ]);
    expect(storageMocks.delete).toHaveBeenCalledTimes(1);
    expect(storageMocks.delete).toHaveBeenCalledWith(
      expect.stringMatching(/^models\/[0-9a-f-]+\/cover\.png$/),
    );
  });

  it('should reject an empty persisted folder', async () => {
    await expect(service.splitModelFolder(
      sourceModelId,
      'outside-empty',
      'Empty',
      userId,
      libraryId,
    )).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'path',
    });
  });

  it('should treat SQL wildcard characters in folder names literally', async () => {
    await db.insert(modelFolders).values([
      { modelId: sourceModelId, path: 'wild_%' },
      { modelId: sourceModelId, path: 'wild-A' },
    ]);
    await db.insert(modelFiles).values([
      {
        modelId: sourceModelId,
        filename: 'move.stl',
        relativePath: 'wild_%/move.stl',
        fileType: 'stl',
        mimeType: 'model/stl',
        sizeBytes: 10,
        storagePath: `models/${sourceModelId}/wild_%/move.stl`,
        hash: 'wild-move-hash',
      },
      {
        modelId: sourceModelId,
        filename: 'stay.stl',
        relativePath: 'wild-A/stay.stl',
        fileType: 'stl',
        mimeType: 'model/stl',
        sizeBytes: 20,
        storagePath: `models/${sourceModelId}/wild-A/stay.stl`,
        hash: 'wild-stay-hash',
      },
    ]);

    const result = await service.splitModelFolder(
      sourceModelId,
      'wild_%',
      'Wild Folder',
      userId,
      libraryId,
    );

    expect(result.movedFileCount).toBe(1);
    expect((await service.getModelFiles(result.newModelId)).map((file) => file.relativePath))
      .toEqual(['move.stl']);
    expect((await service.getModelFiles(sourceModelId)).map((file) => file.relativePath))
      .toContain('wild-A/stay.stl');
  });

  it('should reject a stale file rename after the file moves to another model', async () => {
    let releaseCopy!: () => void;
    let markCopyStarted!: () => void;
    const copyStarted = new Promise<void>((resolve) => {
      markCopyStarted = resolve;
    });
    storageMocks.copy.mockImplementationOnce(async () => {
      markCopyStarted();
      await new Promise<void>((resolve) => {
        releaseCopy = resolve;
      });
    });

    const rename = service.updateModelFileLocation(sourceModelId, imageFileId, {
      filename: 'renamed.png',
      parentPath: 'new-parent',
    });
    await copyStarted;

    const [destination] = await db.insert(models).values({
      name: 'Concurrent Destination',
      slug: `model-split-concurrent-${Date.now()}`,
      userId,
      libraryId,
      sourceType: 'manual',
      status: 'ready',
    }).returning();
    await db
      .update(modelFiles)
      .set({ modelId: destination.id })
      .where(eq(modelFiles.id, imageFileId));
    releaseCopy();

    await expect(rename).rejects.toMatchObject({ code: 'CONFLICT' });
    const [movedFile] = await db
      .select()
      .from(modelFiles)
      .where(eq(modelFiles.id, imageFileId));
    expect(movedFile).toMatchObject({
      modelId: destination.id,
      filename: 'cover.png',
      relativePath: 'bundle/cover.png',
    });
    expect(storageMocks.delete).toHaveBeenCalledWith(
      `models/${sourceModelId}/new-parent/renamed.png`,
    );
    expect((await service.getModelFolders(sourceModelId)).map((folder) => folder.path))
      .not.toContain('new-parent');
  });
});
