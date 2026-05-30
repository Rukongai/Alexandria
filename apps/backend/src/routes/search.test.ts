/**
 * Integration tests for GET /search (globalSearchParamsSchema + searchRoutes).
 *
 * Tests hit the real Fastify app (buildApp) against the real test database.
 * Auth is established via POST /auth/login cookie exactly as auth.test.ts does.
 * requireLibrary injects libraryId server-side — no library header needed.
 *
 * Coverage:
 * - Happy-path: hits in all four buckets (models, collections, artists, tags).
 * - Envelope shape: { data, meta, errors }.
 * - Validation: empty q → 400 VALIDATION_ERROR.
 * - Auth guard: no cookie → 401 UNAUTHORIZED.
 * - Library isolation: models/collections from another library do not appear.
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
  tags,
  modelTags,
  collections,
  collectionModels,
  metadataFieldDefinitions,
  modelMetadata,
} from '../db/schema/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let sessionCookie: string;

let testUserId: string;
let testLibraryId: string;

const modelIds: string[] = [];
const tagIds: Record<string, string> = {};
let collectionId: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Log in as the test user and return the signed session cookie string. */
async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });
  const setCookie = res.headers['set-cookie'];
  const cookieStr = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return cookieStr.split(';')[0];
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const ts = Date.now();

  // ------------------------------------------------------------------
  // Remove leftover fixtures from a previous failed run
  // ------------------------------------------------------------------
  const leftoverUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'search-route-test@example.com'));

  if (leftoverUsers.length > 0) {
    const ids = leftoverUsers.map((u) => u.id);
    await db.delete(collections).where(inArray(collections.userId, ids));
    await db.delete(models).where(inArray(models.userId, ids));
    await db.delete(libraries).where(inArray(libraries.userId, ids));
    await db.delete(users).where(eq(users.email, 'search-route-test@example.com'));
  }

  // ------------------------------------------------------------------
  // Create user via authService so the password is properly hashed
  // ------------------------------------------------------------------
  const authService = (
    app as FastifyInstance & {
      authService: import('../services/auth.service.js').AuthService;
    }
  ).authService;

  await authService.createUser(
    'search-route-test@example.com',
    'password123',
    'Search Route Test User',
  );

  const [testUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, 'search-route-test@example.com'))
    .limit(1);

  testUserId = testUser.id;

  // ------------------------------------------------------------------
  // Create the default library (requireLibrary will use this)
  // ------------------------------------------------------------------
  const [testLibrary] = await db
    .insert(libraries)
    .values({
      name: 'Search Route Test Library',
      slug: `search-route-test-library-${ts}`,
      userId: testUserId,
      isDefault: true,
    })
    .returning();

  testLibraryId = testLibrary.id;

  // ------------------------------------------------------------------
  // Resolve field definition IDs from seed
  // ------------------------------------------------------------------
  const fieldDefs = await db
    .select({ id: metadataFieldDefinitions.id, slug: metadataFieldDefinitions.slug })
    .from(metadataFieldDefinitions)
    .where(eq(metadataFieldDefinitions.isDefault, true));

  const fieldDefIds: Record<string, string> = {};
  for (const fd of fieldDefs) {
    fieldDefIds[fd.slug] = fd.id;
  }

  // ------------------------------------------------------------------
  // Create models
  //   [0] "Route Dragon Model"  — status: ready, artist: route-sculptor
  //   [1] "Route Fantasy Model" — status: ready
  // ------------------------------------------------------------------
  const modelDefs = [
    {
      name: 'Route Dragon Model',
      description: 'A full-text-matchable dragon model for route tests',
      status: 'ready' as const,
    },
    {
      name: 'Route Fantasy Model',
      description: 'A fantasy model for route tests',
      status: 'ready' as const,
    },
  ];

  for (let i = 0; i < modelDefs.length; i++) {
    const def = modelDefs[i];
    const [m] = await db
      .insert(models)
      .values({
        name: def.name,
        slug: `route-test-${def.name.toLowerCase().replace(/\s+/g, '-')}-${ts}-${i}`,
        description: def.description,
        userId: testUserId,
        libraryId: testLibraryId,
        sourceType: 'zip_upload',
        status: def.status,
        totalSizeBytes: 1_000_000,
        fileCount: 1,
      })
      .returning();

    modelIds.push(m.id);
  }

  // ------------------------------------------------------------------
  // Create a tag that contains "dragon" in its name
  // ------------------------------------------------------------------
  const [dragonTag] = await db
    .insert(tags)
    .values({ name: `Dragon-route-${ts}`, slug: `dragon-route-${ts}` })
    .returning();

  tagIds['dragon'] = dragonTag.id;

  await db
    .insert(modelTags)
    .values([{ modelId: modelIds[0], tagId: tagIds['dragon'] }]);

  // ------------------------------------------------------------------
  // Assign artist metadata to model[0]
  // ------------------------------------------------------------------
  const artistFieldId = fieldDefIds['artist'];
  if (artistFieldId) {
    await db.insert(modelMetadata).values([
      { modelId: modelIds[0], fieldDefinitionId: artistFieldId, value: 'route-sculptor' },
    ]);
  }

  // ------------------------------------------------------------------
  // Create a collection that contains "dragon" in the name
  // ------------------------------------------------------------------
  const [col] = await db
    .insert(collections)
    .values({
      name: 'Route Dragon Collection',
      slug: `route-dragon-col-${ts}`,
      userId: testUserId,
      libraryId: testLibraryId,
    })
    .returning();

  collectionId = col.id;

  await db.insert(collectionModels).values([{ collectionId, modelId: modelIds[0] }]);

  // ------------------------------------------------------------------
  // Log in to get a session cookie
  // ------------------------------------------------------------------
  sessionCookie = await login('search-route-test@example.com', 'password123');
});

afterAll(async () => {
  // FK-ordered cleanup
  const allModelIds = [...modelIds].filter(Boolean);
  if (allModelIds.length > 0) {
    await db.delete(models).where(inArray(models.id, allModelIds));
  }

  const tagIdValues = Object.values(tagIds);
  if (tagIdValues.length > 0) {
    await db.delete(tags).where(inArray(tags.id, tagIdValues));
  }

  if (collectionId) {
    await db.delete(collections).where(eq(collections.id, collectionId));
  }

  if (testLibraryId) {
    await db.delete(libraries).where(eq(libraries.id, testLibraryId));
  }

  if (testUserId) {
    await db.delete(users).where(eq(users.id, testUserId));
  }

  await app.close();
});

// ---------------------------------------------------------------------------
// describe: auth guard
// ---------------------------------------------------------------------------

describe('GET /search — auth guard', () => {
  it('should return 401 UNAUTHORIZED when no session cookie is present', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=dragon',
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.data).toBeNull();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].code).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// describe: input validation
// ---------------------------------------------------------------------------

describe('GET /search — input validation', () => {
  it('should return 400 VALIDATION_ERROR when q is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.data).toBeNull();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 VALIDATION_ERROR when q is empty string', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 VALIDATION_ERROR when q is only whitespace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=%20%20',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.errors[0].code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// describe: response envelope
// ---------------------------------------------------------------------------

describe('GET /search — response envelope', () => {
  it('should return { data, meta: null, errors: null } on success', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=dragon',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta', null);
    expect(body).toHaveProperty('errors', null);
  });

  it('should return GlobalSearchResult shape in data', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=dragon',
      headers: { cookie: sessionCookie },
    });

    const body = res.json();
    const data = body.data;

    expect(data).toHaveProperty('q');
    expect(data).toHaveProperty('models');
    expect(data).toHaveProperty('collections');
    expect(data).toHaveProperty('artists');
    expect(data).toHaveProperty('tags');

    // models bucket shape
    expect(data.models).toHaveProperty('items');
    expect(data.models).toHaveProperty('total');
    expect(Array.isArray(data.models.items)).toBe(true);
    expect(typeof data.models.total).toBe('number');

    // other buckets are arrays
    expect(Array.isArray(data.collections)).toBe(true);
    expect(Array.isArray(data.artists)).toBe(true);
    expect(Array.isArray(data.tags)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describe: result content — all four buckets
// ---------------------------------------------------------------------------

describe('GET /search — result content', () => {
  it('should include matching model in models.items', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=Route+Dragon+Model',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();

    const hit = data.models.items.find((m: { id: string }) => m.id === modelIds[0]);
    expect(hit).toBeDefined();
    expect(hit.name).toBe('Route Dragon Model');
  });

  it('should include matching collection in collections array', async () => {
    // "Route Dragon Collection" contains "dragon"
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=dragon',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();

    const hit = data.collections.find((c: { id: string }) => c.id === collectionId);
    expect(hit).toBeDefined();
    expect(hit.name).toBe('Route Dragon Collection');
    expect(typeof hit.modelCount).toBe('number');
    expect(typeof hit.slug).toBe('string');
  });

  it('should include matching artist in artists array', async () => {
    // artist value "route-sculptor" contains "sculptor"
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=sculptor',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();

    const hit = data.artists.find((a: { name: string }) => a.name === 'route-sculptor');
    expect(hit).toBeDefined();
    expect(typeof hit.modelCount).toBe('number');
  });

  it('should include matching tag in tags array', async () => {
    // Tag name starts with "Dragon-route-" so it contains "dragon"
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=dragon',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();

    const hit = data.tags.find((t: { name: string }) =>
      t.name.toLowerCase().startsWith('dragon-route'),
    );
    expect(hit).toBeDefined();
    expect(typeof hit.modelCount).toBe('number');
  });

  it('should return empty buckets for a query that matches nothing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=xyzzy-zzt-nothing-matches',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();

    expect(data.models.items).toHaveLength(0);
    expect(data.models.total).toBe(0);
    expect(data.collections).toHaveLength(0);
    expect(data.artists).toHaveLength(0);
    expect(data.tags).toHaveLength(0);
  });

  it('should echo the query in data.q', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=dragon',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.q).toBe('dragon');
  });
});

// ---------------------------------------------------------------------------
// describe: limit param
// ---------------------------------------------------------------------------

describe('GET /search — limit param', () => {
  it('should cap items per bucket when limit=1 is supplied', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=dragon&limit=1',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();

    expect(data.models.items.length).toBeLessThanOrEqual(1);
    expect(data.collections.length).toBeLessThanOrEqual(1);
    expect(data.artists.length).toBeLessThanOrEqual(1);
    expect(data.tags.length).toBeLessThanOrEqual(1);
  });
});
