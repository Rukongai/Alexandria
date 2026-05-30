/**
 * Integration tests for /smart-collections (P4).
 *
 * Hit the real Fastify app against the real test database. Auth via the login
 * cookie pattern from search.test.ts. requireLibrary injects libraryId.
 *
 * Coverage:
 * - CRUD happy paths + { data, meta, errors } envelope.
 * - GET /:id/models derived result set + ad-hoc pagination.
 * - POST /preview on an unsaved tree.
 * - Cross-tenant guard: another user's smart collection → 404 on every :id route.
 * - Validation: unknown metadata slug → 400; illegal metadata operator → 400;
 *   over-deep tree → 400.
 * - Status-default regression: tree without status → only ready models; a tree
 *   whose rule references status='processing' surfaces processing models.
 * - Library isolation: a model in another library never appears.
 * - Auth guard: no cookie → 401.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { db } from '../db/index.js';
import {
  users,
  libraries,
  models,
  modelFiles,
  tags,
  modelTags,
  metadataFieldDefinitions,
  modelMetadata,
  smartCollections,
} from '../db/schema/index.js';
import type { RuleNode } from '@alexandria/shared';

let app: FastifyInstance;
let sessionCookie: string;
let otherCookie: string;

let userId: string;
let libraryId: string;
let otherUserId: string;
let otherLibraryId: string;

const modelIds: string[] = [];
let dragonModelId: string;
let processingModelId: string;
let otherLibraryModelId: string;
let dragonTagId: string;
let otherSmartId: string;

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  const setCookie = res.headers['set-cookie'];
  const cookieStr = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return cookieStr.split(';')[0];
}

function authedPost(url: string, body: object, cookie = sessionCookie) {
  return app.inject({ method: 'POST', url, headers: { cookie }, payload: body });
}
function authedGet(url: string, cookie = sessionCookie) {
  return app.inject({ method: 'GET', url, headers: { cookie } });
}

const EMAIL = 'sc-route-test@example.com';
const OTHER_EMAIL = 'sc-route-other@example.com';

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const ts = Date.now();

  // Clean leftover fixtures
  const leftover = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, [EMAIL, OTHER_EMAIL]));
  if (leftover.length > 0) {
    const ids = leftover.map((u) => u.id);
    await db.delete(smartCollections).where(inArray(smartCollections.userId, ids));
    await db.delete(models).where(inArray(models.userId, ids));
    await db.delete(libraries).where(inArray(libraries.userId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  }

  const authService = (
    app as FastifyInstance & { authService: import('../services/auth.service.js').AuthService }
  ).authService;
  await authService.createUser(EMAIL, 'password123', 'SC Test User');
  await authService.createUser(OTHER_EMAIL, 'password123', 'SC Other User');

  const [u] = await db.select().from(users).where(eq(users.email, EMAIL)).limit(1);
  const [other] = await db.select().from(users).where(eq(users.email, OTHER_EMAIL)).limit(1);
  userId = u.id;
  otherUserId = other.id;

  const [lib] = await db
    .insert(libraries)
    .values({ name: 'SC Lib', slug: `sc-lib-${ts}`, userId, isDefault: true })
    .returning();
  libraryId = lib.id;
  const [otherLib] = await db
    .insert(libraries)
    .values({ name: 'SC Other Lib', slug: `sc-other-lib-${ts}`, userId: otherUserId, isDefault: true })
    .returning();
  otherLibraryId = otherLib.id;

  const fieldDefs = await db
    .select({ id: metadataFieldDefinitions.id, slug: metadataFieldDefinitions.slug })
    .from(metadataFieldDefinitions)
    .where(eq(metadataFieldDefinitions.isDefault, true));
  const fieldDefIds: Record<string, string> = {};
  for (const fd of fieldDefs) fieldDefIds[fd.slug] = fd.id;

  // Models in the main library
  const defs = [
    { name: 'SC Dragon Model', desc: 'a dragon for sc tests', status: 'ready' as const },
    { name: 'SC Fantasy Model', desc: 'a fantasy model', status: 'ready' as const },
    { name: 'SC Processing Model', desc: 'still processing', status: 'processing' as const },
  ];
  for (let i = 0; i < defs.length; i++) {
    const [m] = await db
      .insert(models)
      .values({
        name: defs[i].name,
        slug: `sc-${i}-${ts}`,
        description: defs[i].desc,
        userId,
        libraryId,
        sourceType: 'zip_upload',
        status: defs[i].status,
        totalSizeBytes: 1_000_000,
        fileCount: 1,
      })
      .returning();
    modelIds.push(m.id);
  }
  dragonModelId = modelIds[0];
  processingModelId = modelIds[2];

  // STL file on the dragon model (for fileType rules)
  await db.insert(modelFiles).values({
    modelId: dragonModelId,
    filename: 'dragon.stl',
    relativePath: 'dragon.stl',
    fileType: 'stl',
    mimeType: 'model/stl',
    sizeBytes: 1000,
    storagePath: `models/${dragonModelId}/dragon.stl`,
    hash: 'a'.repeat(64),
  });

  // Dragon tag on the dragon model
  const [tag] = await db
    .insert(tags)
    .values({ name: `Dragon-sc-${ts}`, slug: `dragon-sc-${ts}` })
    .returning();
  dragonTagId = tag.id;
  await db.insert(modelTags).values({ modelId: dragonModelId, tagId: dragonTagId });

  // Artist metadata on the dragon model
  if (fieldDefIds['artist']) {
    await db.insert(modelMetadata).values({
      modelId: dragonModelId,
      fieldDefinitionId: fieldDefIds['artist'],
      value: 'Loot Studios',
    });
  }

  // A model in ANOTHER library (isolation)
  const [otherModel] = await db
    .insert(models)
    .values({
      name: 'SC Dragon Other Library',
      slug: `sc-other-${ts}`,
      description: 'a dragon in another library',
      userId: otherUserId,
      libraryId: otherLibraryId,
      sourceType: 'zip_upload',
      status: 'ready',
      totalSizeBytes: 1,
      fileCount: 0,
    })
    .returning();
  otherLibraryModelId = otherModel.id;

  // A smart collection owned by the OTHER user (cross-tenant target)
  const [otherSc] = await db
    .insert(smartCollections)
    .values({
      name: 'Other SC',
      slug: `other-sc-${ts}`,
      definition: { kind: 'group', op: 'and', children: [] } as RuleNode,
      userId: otherUserId,
      libraryId: otherLibraryId,
    })
    .returning();
  otherSmartId = otherSc.id;

  sessionCookie = await login(EMAIL, 'password123');
  otherCookie = await login(OTHER_EMAIL, 'password123');
});

afterAll(async () => {
  await db.delete(smartCollections).where(inArray(smartCollections.userId, [userId, otherUserId]));
  const all = [...modelIds, otherLibraryModelId].filter(Boolean);
  if (all.length) await db.delete(models).where(inArray(models.id, all));
  if (dragonTagId) await db.delete(tags).where(eq(tags.id, dragonTagId));
  await db.delete(libraries).where(inArray(libraries.id, [libraryId, otherLibraryId]));
  await db.delete(users).where(inArray(users.id, [userId, otherUserId]));
  await app.close();
});

describe('POST /smart-collections — create', () => {
  it('creates a smart collection and returns detail with modelCount', async () => {
    const definition: RuleNode = {
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'condition', field: { source: 'builtin', field: 'fileType' }, operator: 'has', value: 'stl' },
      ],
    };
    const res = await authedPost('/smart-collections', { name: 'STL models', definition });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.errors).toBeNull();
    expect(body.data.name).toBe('STL models');
    expect(body.data.slug).toBeTruthy();
    expect(body.data.definition).toEqual(definition);
    // only the dragon model has an STL file
    expect(body.data.modelCount).toBe(1);
  });

  it('rejects an unknown metadata field slug with 400', async () => {
    const definition: RuleNode = {
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'condition', field: { source: 'metadata', slug: 'not-a-real-field' }, operator: 'equals', value: 'x' },
      ],
    };
    const res = await authedPost('/smart-collections', { name: 'bad', definition });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('rejects an illegal operator for a metadata field type with 400', async () => {
    // artist is a text field; `has` is not a legal operator for it
    const definition: RuleNode = {
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'condition', field: { source: 'metadata', slug: 'artist' }, operator: 'has', value: 'x' },
      ],
    };
    const res = await authedPost('/smart-collections', { name: 'bad op', definition });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a tree exceeding the max nesting depth with 400', async () => {
    const leaf: RuleNode = { kind: 'condition', field: { source: 'builtin', field: 'status' }, operator: 'is', value: 'ready' };
    const definition: RuleNode = {
      kind: 'group',
      op: 'and',
      children: [{ kind: 'group', op: 'and', children: [{ kind: 'group', op: 'and', children: [{ kind: 'group', op: 'and', children: [leaf] }] }] }],
    };
    const res = await authedPost('/smart-collections', { name: 'too deep', definition });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /smart-collections — list', () => {
  it('lists the user\'s smart collections', async () => {
    const res = await authedGet('/smart-collections');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some((sc: { name: string }) => sc.name === 'STL models')).toBe(true);
    // the other user's smart collection must not leak in
    expect(body.data.some((sc: { id: string }) => sc.id === otherSmartId)).toBe(false);
  });
});

describe('GET /smart-collections/:id/models — derived set', () => {
  it('returns models matching the saved rule tree', async () => {
    const createRes = await authedPost('/smart-collections', {
      name: 'Dragons',
      definition: {
        kind: 'group',
        op: 'and',
        children: [
          { kind: 'condition', field: { source: 'builtin', field: 'fileType' }, operator: 'has', value: 'stl' },
        ],
      },
    });
    const id = createRes.json().data.id;
    const res = await authedGet(`/smart-collections/${id}/models`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta.total).toBe(1);
    expect(body.data[0].id).toBe(dragonModelId);
  });
});

describe('POST /smart-collections/preview — dry run', () => {
  it('returns count + cards for an unsaved tree', async () => {
    const res = await authedPost('/smart-collections/preview', {
      definition: { kind: 'group', op: 'and', children: [] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // empty root = match all READY models in the library (2 of 3; one is processing)
    expect(body.meta.total).toBe(2);
  });
});

describe('status default handling', () => {
  it('a tree without a status rule returns only ready models', async () => {
    const res = await authedPost('/smart-collections/preview', {
      definition: { kind: 'group', op: 'and', children: [] },
    });
    const ids = res.json().data.map((m: { id: string }) => m.id);
    expect(ids).not.toContain(processingModelId);
  });

  it('a tree that references status=processing surfaces processing models', async () => {
    const res = await authedPost('/smart-collections/preview', {
      definition: {
        kind: 'group',
        op: 'and',
        children: [
          { kind: 'condition', field: { source: 'builtin', field: 'status' }, operator: 'is', value: 'processing' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((m: { id: string }) => m.id);
    expect(ids).toContain(processingModelId);
  });
});

describe('library isolation', () => {
  it('never returns a model from another library', async () => {
    const res = await authedPost('/smart-collections/preview', {
      definition: {
        kind: 'group',
        op: 'and',
        children: [
          { kind: 'condition', field: { source: 'builtin', field: 'name' }, operator: 'contains', value: 'dragon' },
        ],
      },
    });
    const ids = res.json().data.map((m: { id: string }) => m.id);
    expect(ids).not.toContain(otherLibraryModelId);
  });
});

describe('cross-tenant guard', () => {
  it('GET /:id → 404 for another user\'s smart collection', async () => {
    expect((await authedGet(`/smart-collections/${otherSmartId}`)).statusCode).toBe(404);
  });
  it('GET /:id/models → 404', async () => {
    expect((await authedGet(`/smart-collections/${otherSmartId}/models`)).statusCode).toBe(404);
  });
  it('PATCH /:id → 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/smart-collections/${otherSmartId}`,
      headers: { cookie: sessionCookie },
      payload: { name: 'hijack' },
    });
    expect(res.statusCode).toBe(404);
  });
  it('DELETE /:id → 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/smart-collections/${otherSmartId}`,
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(404);
  });
  it('the other user CAN access their own smart collection', async () => {
    expect((await authedGet(`/smart-collections/${otherSmartId}`, otherCookie)).statusCode).toBe(200);
  });
});

describe('PATCH + DELETE lifecycle', () => {
  it('updates then deletes a smart collection', async () => {
    const create = await authedPost('/smart-collections', {
      name: 'Temp',
      definition: { kind: 'group', op: 'and', children: [] },
    });
    const id = create.json().data.id;

    const patch = await app.inject({
      method: 'PATCH',
      url: `/smart-collections/${id}`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Renamed' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.name).toBe('Renamed');

    const del = await app.inject({
      method: 'DELETE',
      url: `/smart-collections/${id}`,
      headers: { cookie: sessionCookie },
    });
    expect(del.statusCode).toBe(200);
    expect((await authedGet(`/smart-collections/${id}`)).statusCode).toBe(404);
  });
});

describe('auth guard', () => {
  it('401 without a session cookie', async () => {
    expect((await app.inject({ method: 'GET', url: '/smart-collections' })).statusCode).toBe(401);
  });
});
