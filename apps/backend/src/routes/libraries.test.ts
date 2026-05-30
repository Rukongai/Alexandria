/**
 * Integration tests for /libraries (P5 multi-library).
 *
 * Hit the real Fastify app against the real test database. Auth via the login
 * cookie pattern from smart-collections.test.ts.
 *
 * Coverage:
 * - CRUD happy paths + { data, meta, errors } envelope; color defaulting.
 * - listLibraries derived model/collection counts, default-first ordering.
 * - set-default flips exactly one default.
 * - delete guards: 409 when default / non-empty / only-library; 200 when empty
 *   non-default; list reflects the removal.
 * - Cross-tenant guard: another user's library → 404 on every :id route.
 * - Active-library scoping via X-Library-Id: content is scoped to the header
 *   library; absent header falls back to default; un-owned id → 404.
 * - Auth guard: no cookie → 401.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { db } from '../db/index.js';
import { users, libraries, models, collections } from '../db/schema/index.js';

let app: FastifyInstance;
let sessionCookie: string;

let userId: string;
let defaultLibraryId: string;
let secondLibraryId: string;
let otherUserId: string;
let otherLibraryId: string;

const EMAIL = 'lib-route-test@example.com';
const OTHER_EMAIL = 'lib-route-other@example.com';
const SINGLE_EMAIL = 'lib-route-single@example.com';

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  const setCookie = res.headers['set-cookie'];
  const cookieStr = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return cookieStr.split(';')[0];
}

function authedGet(url: string, cookie = sessionCookie, libraryId?: string) {
  const headers: Record<string, string> = { cookie };
  if (libraryId) headers['x-library-id'] = libraryId;
  return app.inject({ method: 'GET', url, headers });
}
function authedPost(url: string, body: object, cookie = sessionCookie, libraryId?: string) {
  const headers: Record<string, string> = { cookie };
  if (libraryId) headers['x-library-id'] = libraryId;
  return app.inject({ method: 'POST', url, headers, payload: body });
}
function authedPatch(url: string, body: object, cookie = sessionCookie) {
  return app.inject({ method: 'PATCH', url, headers: { cookie }, payload: body });
}
function authedDelete(url: string, cookie = sessionCookie) {
  return app.inject({ method: 'DELETE', url, headers: { cookie } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const ts = Date.now();

  const emails = [EMAIL, OTHER_EMAIL, SINGLE_EMAIL];
  const leftover = await db.select({ id: users.id }).from(users).where(inArray(users.email, emails));
  if (leftover.length > 0) {
    const ids = leftover.map((u) => u.id);
    await db.delete(collections).where(inArray(collections.userId, ids));
    await db.delete(models).where(inArray(models.userId, ids));
    await db.delete(libraries).where(inArray(libraries.userId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  }

  const authService = (
    app as FastifyInstance & { authService: import('../services/auth.service.js').AuthService }
  ).authService;
  await authService.createUser(EMAIL, 'password123', 'Lib Test User');
  await authService.createUser(OTHER_EMAIL, 'password123', 'Lib Other User');
  await authService.createUser(SINGLE_EMAIL, 'password123', 'Lib Single User');

  const [u] = await db.select().from(users).where(eq(users.email, EMAIL)).limit(1);
  const [other] = await db.select().from(users).where(eq(users.email, OTHER_EMAIL)).limit(1);
  userId = u.id;
  otherUserId = other.id;

  // User A: a default library ("Main") with one model + one collection, and an
  // empty second library.
  const [mainLib] = await db
    .insert(libraries)
    .values({ name: 'Main', slug: `main-${ts}`, userId, isDefault: true })
    .returning();
  defaultLibraryId = mainLib.id;
  const [secondLib] = await db
    .insert(libraries)
    .values({ name: 'Minis', slug: `minis-${ts}`, userId, isDefault: false, color: 'teal' })
    .returning();
  secondLibraryId = secondLib.id;

  await db.insert(models).values({
    name: 'Main Model',
    slug: `main-model-${ts}`,
    userId,
    libraryId: defaultLibraryId,
    status: 'ready',
    sourceType: 'upload',
  });
  await db.insert(collections).values({
    name: 'Main Collection',
    slug: `main-collection-${ts}`,
    userId,
    libraryId: defaultLibraryId,
  });

  // Other user: their own default library (cross-tenant target).
  const [otherLib] = await db
    .insert(libraries)
    .values({ name: 'Other', slug: `other-${ts}`, userId: otherUserId, isDefault: true })
    .returning();
  otherLibraryId = otherLib.id;

  sessionCookie = await login(EMAIL, 'password123');
});

afterAll(async () => {
  const emails = [EMAIL, OTHER_EMAIL, SINGLE_EMAIL];
  const rows = await db.select({ id: users.id }).from(users).where(inArray(users.email, emails));
  const ids = rows.map((u) => u.id);
  if (ids.length > 0) {
    await db.delete(collections).where(inArray(collections.userId, ids));
    await db.delete(models).where(inArray(models.userId, ids));
    await db.delete(libraries).where(inArray(libraries.userId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  }
  await app.close();
});

describe('GET /libraries', () => {
  it('lists the user libraries default-first with derived counts', async () => {
    const res = await authedGet('/libraries');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.errors).toBeNull();
    expect(body.meta.total).toBeGreaterThanOrEqual(2);

    const main = body.data.find((l: { id: string }) => l.id === defaultLibraryId);
    const minis = body.data.find((l: { id: string }) => l.id === secondLibraryId);
    expect(main).toMatchObject({ name: 'Main', isDefault: true, color: 'amber', modelCount: 1, collectionCount: 1 });
    expect(minis).toMatchObject({ name: 'Minis', isDefault: false, color: 'teal', modelCount: 0, collectionCount: 0 });

    // Default sorts first.
    expect(body.data[0].isDefault).toBe(true);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/libraries' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /libraries', () => {
  it('creates a non-default library with default color', async () => {
    const res = await authedPost('/libraries', { name: 'Reference Kit' });
    expect(res.statusCode).toBe(201);
    const lib = res.json().data;
    expect(lib).toMatchObject({ name: 'Reference Kit', isDefault: false, color: 'amber', modelCount: 0, collectionCount: 0 });
    expect(lib.slug).toMatch(/^reference-kit/);

    // Clean up so later count assertions stay stable.
    await authedDelete(`/libraries/${lib.id}`);
  });

  it('accepts an explicit color and rejects an invalid one', async () => {
    const ok = await authedPost('/libraries', { name: 'Plum Lib', color: 'plum' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().data.color).toBe('plum');
    await authedDelete(`/libraries/${ok.json().data.id}`);

    const bad = await authedPost('/libraries', { name: 'Bad', color: 'rainbow' });
    expect(bad.statusCode).toBe(400);
  });

  it('rejects a blank name', async () => {
    const res = await authedPost('/libraries', { name: '   ' });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /libraries/:id', () => {
  it('renames and recolors, regenerating the slug', async () => {
    const created = (await authedPost('/libraries', { name: 'Temp Name' })).json().data;
    const res = await authedPatch(`/libraries/${created.id}`, { name: 'Painted Minis', color: 'sage' });
    expect(res.statusCode).toBe(200);
    const lib = res.json().data;
    expect(lib).toMatchObject({ name: 'Painted Minis', color: 'sage' });
    expect(lib.slug).toMatch(/^painted-minis/);
    await authedDelete(`/libraries/${created.id}`);
  });

  it('404s on another user library', async () => {
    const res = await authedPatch(`/libraries/${otherLibraryId}`, { name: 'Hijack' });
    expect(res.statusCode).toBe(404);
  });

  it('400s when no fields are provided', async () => {
    const res = await authedPatch(`/libraries/${secondLibraryId}`, {});
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /libraries/:id/set-default', () => {
  it('flips the default to exactly one library', async () => {
    const res = await authedPost(`/libraries/${secondLibraryId}/set-default`, {});
    expect(res.statusCode).toBe(200);

    const rows = await db.select().from(libraries).where(eq(libraries.userId, userId));
    const defaults = rows.filter((r) => r.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(secondLibraryId);

    // Restore Main as default for the remaining tests.
    await authedPost(`/libraries/${defaultLibraryId}/set-default`, {});
    const restored = (await db.select().from(libraries).where(eq(libraries.id, defaultLibraryId)))[0];
    expect(restored.isDefault).toBe(true);
  });

  it('404s on another user library', async () => {
    const res = await authedPost(`/libraries/${otherLibraryId}/set-default`, {});
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /libraries/:id', () => {
  it('409s when the library is the default', async () => {
    const res = await authedDelete(`/libraries/${defaultLibraryId}`);
    expect(res.statusCode).toBe(409);
  });

  it('409s when the library still contains models or collections', async () => {
    // Give the (non-default) second library a collection, then try to delete it.
    const lib = (await authedPost('/libraries', { name: 'Has Content' })).json().data;
    await authedPost('/collections', { name: 'Inside' }, sessionCookie, lib.id);
    const res = await authedDelete(`/libraries/${lib.id}`);
    expect(res.statusCode).toBe(409);

    // Remove the collection, then deletion succeeds.
    await db.delete(collections).where(eq(collections.libraryId, lib.id));
    const ok = await authedDelete(`/libraries/${lib.id}`);
    expect(ok.statusCode).toBe(200);
  });

  it('409s when it is the user only library', async () => {
    const [single] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, SINGLE_EMAIL));
    const [onlyLib] = await db
      .insert(libraries)
      .values({ name: 'Solo', slug: `solo-${Date.now()}`, userId: single.id, isDefault: false })
      .returning();
    const singleCookie = await login(SINGLE_EMAIL, 'password123');
    const res = await authedDelete(`/libraries/${onlyLib.id}`, singleCookie);
    expect(res.statusCode).toBe(409);
  });

  it('deletes an empty, non-default library and removes it from the list', async () => {
    const lib = (await authedPost('/libraries', { name: 'Disposable' })).json().data;
    const res = await authedDelete(`/libraries/${lib.id}`);
    expect(res.statusCode).toBe(200);

    const list = (await authedGet('/libraries')).json().data;
    expect(list.find((l: { id: string }) => l.id === lib.id)).toBeUndefined();
  });

  it('404s on another user library', async () => {
    const res = await authedDelete(`/libraries/${otherLibraryId}`);
    expect(res.statusCode).toBe(404);
  });
});

describe('active-library scoping via X-Library-Id', () => {
  it('scopes content to the header library and falls back to default when absent', async () => {
    // Create a collection in the second (empty) library via the header.
    const created = await authedPost('/collections', { name: 'Scoped Coll' }, sessionCookie, secondLibraryId);
    expect(created.statusCode).toBe(201);

    // With the header, the second library shows the new collection.
    const scoped = (await authedGet('/collections', sessionCookie, secondLibraryId)).json().data;
    expect(scoped.some((c: { name: string }) => c.name === 'Scoped Coll')).toBe(true);

    // Without the header (→ default library), it does not.
    const def = (await authedGet('/collections')).json().data;
    expect(def.some((c: { name: string }) => c.name === 'Scoped Coll')).toBe(false);
    expect(def.some((c: { name: string }) => c.name === 'Main Collection')).toBe(true);

    await db.delete(collections).where(eq(collections.libraryId, secondLibraryId));
  });

  it('404s when the header references an un-owned library', async () => {
    const res = await authedGet('/collections', sessionCookie, otherLibraryId);
    expect(res.statusCode).toBe(404);
  });
});
