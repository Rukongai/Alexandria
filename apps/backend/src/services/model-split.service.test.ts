import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

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
  modelFiles,
  modelFolders,
  models,
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
