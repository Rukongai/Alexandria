import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { DatabaseExecutor } from '../db/index.js';

const storageMocks = vi.hoisted(() => ({
  deleteMany: vi.fn(),
}));

vi.mock('./storage.service.js', () => ({
  storageService: { deleteMany: storageMocks.deleteMany },
}));

import { db, pool } from '../db/index.js';
import { libraries, modelFiles, models, thumbnails, users } from '../db/schema/index.js';
import { ModelService } from './model.service.js';

const TEST_EMAIL = 'model-delete-test@example.com';
const service = new ModelService();

let userId: string;
let libraryId: string;
let modelId: string;
let selectedFileIds: string[];

async function deleteTestUser(): Promise<void> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, TEST_EMAIL));
  if (rows.length === 0) return;
  const userIds = rows.map((row) => row.id);
  await db.delete(models).where(inArray(models.userId, userIds));
  await db.delete(libraries).where(inArray(libraries.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
}

async function waitForBlockedModelLock(): Promise<number[]> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blockingPids: number[] }>(`
      SELECT pg_blocking_pids(pid) AS "blockingPids"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%"models"%'
        AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    const blocked = result.rows[0]?.blockingPids;
    if (blocked && blocked.length > 0) return blocked;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected a model-row lock waiter');
}

beforeAll(async () => {
  await deleteTestUser();
  const [user] = await db.insert(users).values({
    email: TEST_EMAIL,
    displayName: 'Model Delete Test',
    passwordHash: 'not-a-real-hash',
    role: 'admin',
  }).returning();
  userId = user.id;

  const [library] = await db.insert(libraries).values({
    name: 'Model Delete Library',
    slug: `model-delete-library-${Date.now()}`,
    userId,
    isDefault: true,
  }).returning();
  libraryId = library.id;
});

beforeEach(async () => {
  vi.clearAllMocks();
  storageMocks.deleteMany.mockResolvedValue([]);

  const [model] = await db.insert(models).values({
    name: 'Delete Selection Model',
    slug: `model-delete-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    userId,
    libraryId,
    sourceType: 'manual',
    status: 'ready',
    fileCount: 3,
    totalSizeBytes: 600,
  }).returning();
  modelId = model.id;

  const files = await db.insert(modelFiles).values([
    {
      modelId,
      filename: 'one.png',
      relativePath: 'one.png',
      fileType: 'image',
      mimeType: 'image/png',
      sizeBytes: 100,
      storagePath: `models/${modelId}/one.png`,
      hash: 'delete-one-hash',
    },
    {
      modelId,
      filename: 'two.stl',
      relativePath: 'two.stl',
      fileType: 'stl',
      mimeType: 'model/stl',
      sizeBytes: 200,
      storagePath: `models/${modelId}/two.stl`,
      hash: 'delete-two-hash',
    },
    {
      modelId,
      filename: 'keep.stl',
      relativePath: 'keep.stl',
      fileType: 'stl',
      mimeType: 'model/stl',
      sizeBytes: 300,
      storagePath: `models/${modelId}/keep.stl`,
      hash: 'delete-keep-hash',
    },
  ]).returning();
  selectedFileIds = files.slice(0, 2).map((file) => file.id);
  await db.insert(thumbnails).values({
    sourceFileId: files[0].id,
    storagePath: `thumbnails/${modelId}/one-grid.webp`,
    width: 400,
    height: 400,
    format: 'webp',
  });
});

afterEach(async () => {
  await db.delete(models).where(eq(models.userId, userId));
});

afterAll(async () => {
  await deleteTestUser();
});

describe('ModelService – deleteModelFiles', () => {
  it('deletes the complete selection and recalculates stats once', async () => {
    await service.deleteModelFiles(modelId, selectedFileIds);

    expect((await service.getModelFiles(modelId)).map((file) => file.relativePath))
      .toEqual(['keep.stl']);
    expect(await service.getModelById(modelId)).toMatchObject({
      fileCount: 1,
      totalSizeBytes: 300,
    });
    expect(await db.select().from(thumbnails).where(inArray(
      thumbnails.sourceFileId,
      selectedFileIds,
    ))).toEqual([]);
    expect(storageMocks.deleteMany).toHaveBeenCalledOnce();
    expect(storageMocks.deleteMany).toHaveBeenCalledWith(expect.arrayContaining([
      `models/${modelId}/one.png`,
      `models/${modelId}/two.stl`,
      `thumbnails/${modelId}/one-grid.webp`,
    ]));
  });

  it('leaves every selected file intact when any ID is missing', async () => {
    await expect(service.deleteModelFiles(modelId, [
      selectedFileIds[0],
      '99999999-9999-4999-8999-999999999999',
    ])).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await service.getModelFiles(modelId)).toHaveLength(3);
    expect(await service.getModelById(modelId)).toMatchObject({
      fileCount: 3,
      totalSizeBytes: 600,
    });
    expect(storageMocks.deleteMany).not.toHaveBeenCalled();
  });

  it('serializes concurrent deletions before recalculating model statistics', async () => {
    let resolveFirstRecalculation!: () => void;
    let releaseFirstRecalculation!: () => void;
    const firstRecalculationEntered = new Promise<void>((resolve) => {
      resolveFirstRecalculation = resolve;
    });
    const firstRecalculationReleased = new Promise<void>((resolve) => {
      releaseFirstRecalculation = resolve;
    });

    class BlockingModelService extends ModelService {
      recalculationCount = 0;

      override async recalculateModelStats(
        recalculatedModelId: string,
        executor?: DatabaseExecutor,
      ): Promise<void> {
        this.recalculationCount += 1;
        if (this.recalculationCount === 1) {
          resolveFirstRecalculation();
          await firstRecalculationReleased;
        }
        await super.recalculateModelStats(recalculatedModelId, executor);
      }
    }

    const blockingService = new BlockingModelService();
    const firstDelete = blockingService.deleteModelFile(modelId, selectedFileIds[0]);
    await firstRecalculationEntered;
    const secondDelete = blockingService.deleteModelFile(modelId, selectedFileIds[1]);

    try {
      expect(await waitForBlockedModelLock()).not.toEqual([]);
      expect(blockingService.recalculationCount).toBe(1);
    } finally {
      releaseFirstRecalculation();
    }

    await Promise.all([firstDelete, secondDelete]);
    expect(blockingService.recalculationCount).toBe(2);
    expect(await service.getModelById(modelId)).toMatchObject({
      fileCount: 1,
      totalSizeBytes: 300,
    });
  });
});
