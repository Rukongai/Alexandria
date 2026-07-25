/**
 * Integration coverage for GET /tools/duplicates.
 *
 * These tests exercise the complete Fastify/auth/library/service/database path.
 * Every library contains models with the same file-hash multiset so successful
 * scans also prove that duplicate groups cannot cross a library or tenant
 * boundary.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { db } from '../db/index.js';
import { libraries, modelFiles, models, users } from '../db/schema/index.js';

const OWNER_EMAIL = 'tools-duplicates-route-owner@example.com';
const OTHER_TENANT_EMAIL = 'tools-duplicates-route-tenant@example.com';
const PASSWORD = 'password123';
const SHARED_HASHES = ['1'.repeat(64), '2'.repeat(64)];

let app: FastifyInstance;
let sessionCookie: string;
let ownerDefaultLibraryId: string;
let ownerSecondLibraryId: string;
let otherTenantLibraryId: string;
let defaultModelIds: string[];
let partialDuplicateModelId: string;
let secondLibraryModelIds: string[];
let otherTenantModelIds: string[];

async function cleanupFixtures(): Promise<void> {
  const fixtureUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, [OWNER_EMAIL, OTHER_TENANT_EMAIL]));

  const userIds = fixtureUsers.map((user) => user.id);
  if (userIds.length === 0) return;

  // Model-file rows cascade from models. Remove the remaining rows in FK order.
  await db.delete(models).where(inArray(models.userId, userIds));
  await db.delete(libraries).where(inArray(libraries.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
}

async function login(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Fixture login failed with ${response.statusCode}: ${response.body}`);
  }

  const setCookie = response.headers['set-cookie'];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookie) throw new Error('Fixture login did not return a session cookie');
  return cookie.split(';')[0];
}

async function createDuplicatePair(options: {
  label: string;
  runToken: string;
  userId: string;
  libraryId: string;
  createdAt: [Date, Date];
  totalSizeBytes: [number, number];
}): Promise<string[]> {
  const insertedModels = await db
    .insert(models)
    .values([0, 1].map((index) => ({
      name: `${options.label} ${index + 1}`,
      slug: `${options.runToken}-${options.label.toLowerCase().replaceAll(' ', '-')}-${index + 1}`,
      userId: options.userId,
      libraryId: options.libraryId,
      sourceType: 'manual',
      status: 'ready',
      originalFilename: `${options.label.toLowerCase().replaceAll(' ', '-')}-${index + 1}.zip`,
      totalSizeBytes: options.totalSizeBytes[index],
      fileCount: SHARED_HASHES.length,
      createdAt: options.createdAt[index],
      updatedAt: options.createdAt[index],
    })))
    .returning({ id: models.id });

  for (const [modelIndex, model] of insertedModels.entries()) {
    await db.insert(modelFiles).values(SHARED_HASHES.map((hash, fileIndex) => ({
      modelId: model.id,
      filename: `part-${fileIndex + 1}-${modelIndex + 1}.stl`,
      relativePath: `parts/part-${fileIndex + 1}-${modelIndex + 1}.stl`,
      fileType: 'stl',
      mimeType: 'model/stl',
      sizeBytes: 50 + fileIndex,
      storagePath: `models/${model.id}/part-${fileIndex + 1}.stl`,
      hash,
      createdAt: options.createdAt[modelIndex],
    })));
  }

  return insertedModels.map((model) => model.id);
}

function scanDuplicates(libraryId?: string) {
  const headers: Record<string, string> = { cookie: sessionCookie };
  if (libraryId) headers['x-library-id'] = libraryId;
  return app.inject({ method: 'GET', url: '/tools/duplicates', headers });
}

beforeAll(async () => {
  await cleanupFixtures();

  app = await buildApp();
  await app.ready();

  const runToken = `tools-duplicates-${Date.now()}-${process.pid}`;
  const authService = (
    app as FastifyInstance & {
      authService: import('../services/auth.service.js').AuthService;
    }
  ).authService;

  await authService.createUser(OWNER_EMAIL, PASSWORD, 'Duplicate Tools Owner');
  await authService.createUser(OTHER_TENANT_EMAIL, PASSWORD, 'Duplicate Tools Tenant');

  const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.email, OWNER_EMAIL));
  const [otherTenant] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, OTHER_TENANT_EMAIL));

  const [defaultLibrary] = await db
    .insert(libraries)
    .values({
      name: 'Duplicate Tools Default',
      slug: `${runToken}-default-library`,
      userId: owner.id,
      isDefault: true,
    })
    .returning({ id: libraries.id });
  ownerDefaultLibraryId = defaultLibrary.id;

  const [secondLibrary] = await db
    .insert(libraries)
    .values({
      name: 'Duplicate Tools Second',
      slug: `${runToken}-second-library`,
      userId: owner.id,
      isDefault: false,
    })
    .returning({ id: libraries.id });
  ownerSecondLibraryId = secondLibrary.id;

  const [tenantLibrary] = await db
    .insert(libraries)
    .values({
      name: 'Duplicate Tools Other Tenant',
      slug: `${runToken}-tenant-library`,
      userId: otherTenant.id,
      isDefault: true,
    })
    .returning({ id: libraries.id });
  otherTenantLibraryId = tenantLibrary.id;

  defaultModelIds = await createDuplicatePair({
    label: 'Default Pair',
    runToken,
    userId: owner.id,
    libraryId: ownerDefaultLibraryId,
    createdAt: [new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z')],
    totalSizeBytes: [100, 200],
  });

  const partialDuplicateCreatedAt = new Date('2026-01-03T00:00:00.000Z');
  const [partialDuplicateModel] = await db
    .insert(models)
    .values({
      name: 'Partial File Match',
      slug: `${runToken}-partial-file-match`,
      userId: owner.id,
      libraryId: ownerDefaultLibraryId,
      sourceType: 'manual',
      status: 'ready',
      originalFilename: 'partial-file-match.zip',
      totalSizeBytes: 121,
      fileCount: 2,
      createdAt: partialDuplicateCreatedAt,
      updatedAt: partialDuplicateCreatedAt,
    })
    .returning({ id: models.id });
  partialDuplicateModelId = partialDuplicateModel.id;
  await db.insert(modelFiles).values([
    {
      modelId: partialDuplicateModelId,
      filename: 'shared-part.stl',
      relativePath: 'alternate/shared-part.stl',
      fileType: 'stl',
      mimeType: 'model/stl',
      sizeBytes: 60,
      storagePath: `models/${partialDuplicateModelId}/shared-part.stl`,
      hash: SHARED_HASHES[0],
      createdAt: partialDuplicateCreatedAt,
    },
    {
      modelId: partialDuplicateModelId,
      filename: 'unique-part.stl',
      relativePath: 'unique-part.stl',
      fileType: 'stl',
      mimeType: 'model/stl',
      sizeBytes: 61,
      storagePath: `models/${partialDuplicateModelId}/unique-part.stl`,
      hash: '3'.repeat(64),
      createdAt: partialDuplicateCreatedAt,
    },
  ]);

  const [processingModel] = await db
    .insert(models)
    .values({
      name: 'Processing Duplicate',
      slug: `${runToken}-processing-duplicate`,
      userId: owner.id,
      libraryId: ownerDefaultLibraryId,
      sourceType: 'manual',
      status: 'processing',
      totalSizeBytes: 100,
      fileCount: SHARED_HASHES.length,
    })
    .returning({ id: models.id });
  await db.insert(modelFiles).values(SHARED_HASHES.map((hash, index) => ({
    modelId: processingModel.id,
    filename: `processing-${index}.stl`,
    relativePath: `processing-${index}.stl`,
    fileType: 'stl',
    mimeType: 'model/stl',
    sizeBytes: 50 + index,
    storagePath: `models/${processingModel.id}/processing-${index}.stl`,
    hash,
  })));
  await db.insert(models).values({
    name: 'Empty Ready Model',
    slug: `${runToken}-empty-ready-model`,
    userId: owner.id,
    libraryId: ownerDefaultLibraryId,
    sourceType: 'manual',
    status: 'ready',
    totalSizeBytes: 0,
    fileCount: 0,
  });

  secondLibraryModelIds = await createDuplicatePair({
    label: 'Second Pair',
    runToken,
    userId: owner.id,
    libraryId: ownerSecondLibraryId,
    createdAt: [new Date('2026-02-01T00:00:00.000Z'), new Date('2026-02-02T00:00:00.000Z')],
    totalSizeBytes: [300, 400],
  });
  otherTenantModelIds = await createDuplicatePair({
    label: 'Tenant Pair',
    runToken,
    userId: otherTenant.id,
    libraryId: otherTenantLibraryId,
    createdAt: [new Date('2026-03-01T00:00:00.000Z'), new Date('2026-03-02T00:00:00.000Z')],
    totalSizeBytes: [500, 600],
  });

  sessionCookie = await login(OWNER_EMAIL);
});

afterAll(async () => {
  await cleanupFixtures();
  await app?.close();
});

describe('GET /tools/duplicates integration', () => {
  it('should return a standard 401 envelope when the session cookie is absent', async () => {
    const response = await app.inject({ method: 'GET', url: '/tools/duplicates' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      data: null,
      meta: null,
      errors: [
        {
          code: 'UNAUTHORIZED',
          field: null,
          message: 'Authentication required',
        },
      ],
    });
  });

  it('should scan the default library when X-Library-Id is absent', async () => {
    const response = await scanDuplicates();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      data: {
        scannedModelCount: 3,
        scannedFileCount: 6,
        redundantModelCount: 1,
        redundantFileCount: 3,
        reclaimableBytes: 200,
        fileReclaimableBytes: 161,
        groups: [
          {
            fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
            fileCount: 2,
            totalSizeBytes: 100,
            reclaimableBytes: 200,
            models: [
              {
                id: defaultModelIds[0],
                name: 'Default Pair 1',
                originalFilename: 'default-pair-1.zip',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
              {
                id: defaultModelIds[1],
                name: 'Default Pair 2',
                originalFilename: 'default-pair-2.zip',
                createdAt: '2026-01-02T00:00:00.000Z',
              },
            ],
          },
        ],
        fileGroups: [
          {
            hash: SHARED_HASHES[0],
            sizeBytes: 50,
            reclaimableBytes: 110,
            files: [
              {
                id: expect.any(String),
                modelId: defaultModelIds[0],
                modelName: 'Default Pair 1',
                filename: 'part-1-1.stl',
                relativePath: 'parts/part-1-1.stl',
                sizeBytes: 50,
                createdAt: '2026-01-01T00:00:00.000Z',
              },
              {
                id: expect.any(String),
                modelId: defaultModelIds[1],
                modelName: 'Default Pair 2',
                filename: 'part-1-2.stl',
                relativePath: 'parts/part-1-2.stl',
                sizeBytes: 50,
                createdAt: '2026-01-02T00:00:00.000Z',
              },
              {
                id: expect.any(String),
                modelId: partialDuplicateModelId,
                modelName: 'Partial File Match',
                filename: 'shared-part.stl',
                relativePath: 'alternate/shared-part.stl',
                sizeBytes: 60,
                createdAt: '2026-01-03T00:00:00.000Z',
              },
            ],
          },
          {
            hash: SHARED_HASHES[1],
            sizeBytes: 51,
            reclaimableBytes: 51,
            files: [
              {
                id: expect.any(String),
                modelId: defaultModelIds[0],
                modelName: 'Default Pair 1',
                filename: 'part-2-1.stl',
                relativePath: 'parts/part-2-1.stl',
                sizeBytes: 51,
                createdAt: '2026-01-01T00:00:00.000Z',
              },
              {
                id: expect.any(String),
                modelId: defaultModelIds[1],
                modelName: 'Default Pair 2',
                filename: 'part-2-2.stl',
                relativePath: 'parts/part-2-2.stl',
                sizeBytes: 51,
                createdAt: '2026-01-02T00:00:00.000Z',
              },
            ],
          },
        ],
      },
      meta: null,
      errors: null,
    });

    const returnedIds = body.data.groups.flatMap(
      (group: { models: Array<{ id: string }> }) => group.models.map((model) => model.id),
    );
    expect(returnedIds).not.toContain(secondLibraryModelIds[0]);
    expect(returnedIds).not.toContain(otherTenantModelIds[0]);
    expect(returnedIds).not.toContain(partialDuplicateModelId);
    expect(body.data.fileGroups[0].files.map((file: { modelId: string }) => file.modelId))
      .toContain(partialDuplicateModelId);
  });

  it('should scan only an explicitly selected owned library', async () => {
    const response = await scanDuplicates(ownerSecondLibraryId);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta).toBeNull();
    expect(body.errors).toBeNull();
    expect(body.data).toMatchObject({
      scannedModelCount: 2,
      redundantModelCount: 1,
      reclaimableBytes: 400,
      groups: [
        {
          fileCount: 2,
          totalSizeBytes: 300,
          reclaimableBytes: 400,
        },
      ],
    });
    expect(body.data.groups[0].models.map((model: { id: string }) => model.id))
      .toEqual(secondLibraryModelIds);
    expect(body.data.groups[0].models.map((model: { id: string }) => model.id))
      .not.toContain(defaultModelIds[0]);
    expect(body.data.groups[0].models.map((model: { id: string }) => model.id))
      .not.toContain(otherTenantModelIds[0]);
  });

  it("should return 404 when X-Library-Id references another user's library", async () => {
    const response = await scanDuplicates(otherTenantLibraryId);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      data: null,
      meta: null,
      errors: [
        {
          code: 'NOT_FOUND',
          field: null,
          message: 'Library not found',
        },
      ],
    });
  });
});
