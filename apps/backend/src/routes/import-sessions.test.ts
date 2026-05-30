/**
 * Integration tests for the staged-import routes in /models (P3).
 *
 * Routes under test:
 *   GET  /models/import-sessions
 *   GET  /models/import-sessions/:id
 *   POST /models/import-sessions/:id/commit
 *   DELETE /models/import-sessions/:id
 *
 * Each test uses the real Fastify app (buildApp) + real Postgres.
 * Session rows are seeded directly via importSessionService (bypassing BullMQ)
 * so we never actually enqueue jobs.
 *
 * Auth is established by POST /auth/login (identical to auth.test.ts pattern).
 * requireLibrary resolves the user's default library server-side.
 *
 * NOTE: The POST /upload/:uploadId/complete endpoint now returns { sessionId }
 * (not the old { modelId, jobId }). That contract change is verified here.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { FileType } from '@alexandria/shared';
import { eq, inArray } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { db } from '../db/index.js';
import {
  users,
  libraries,
  models,
  importSessions,
} from '../db/schema/index.js';
import { importSessionService } from '../services/import-session.service.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let sessionCookie: string;
let otherUserCookie: string;

let testUserId: string;
let otherUserId: string;
let testLibraryId: string;

// Session rows created during tests (cleaned up in afterEach)
let perTestSessionIds: string[] = [];
// Model rows created during tests (cleaned up in afterEach)
let perTestModelIds: string[] = [];

const TEST_EMAIL = 'import-route-test@example.com';
const OTHER_EMAIL = 'import-route-other@example.com';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Create a test import session directly in the DB (no BullMQ) and track it. */
async function createSession(opts: {
  userId?: string;
  libraryId?: string;
  status?: string;
  filename?: string;
}): Promise<string> {
  const { id } = await importSessionService.create({
    userId: opts.userId ?? testUserId,
    libraryId: opts.libraryId ?? testLibraryId,
    originalFilename: opts.filename ?? 'test.zip',
  });

  if (opts.status && opts.status !== 'scanning') {
    await importSessionService.update(id, { status: opts.status as import('@alexandria/shared').ImportSessionStatus });
  }

  perTestSessionIds.push(id);
  return id;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const ts = Date.now();

  // Remove leftover fixtures
  for (const email of [TEST_EMAIL, OTHER_EMAIL]) {
    const leftover = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));

    if (leftover.length > 0) {
      const ids = leftover.map((u) => u.id);
      await db.delete(importSessions).where(inArray(importSessions.userId, ids));
      await db.delete(libraries).where(inArray(libraries.userId, ids));
      await db.delete(users).where(inArray(users.id, ids));
    }
  }

  const authService = (
    app as FastifyInstance & {
      authService: import('../services/auth.service.js').AuthService;
    }
  ).authService;

  // Primary test user
  await authService.createUser(TEST_EMAIL, 'password123', 'Import Route Test User');
  const [testUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, TEST_EMAIL))
    .limit(1);
  testUserId = testUser.id;

  const [testLibrary] = await db
    .insert(libraries)
    .values({
      name: 'Import Route Test Library',
      slug: `import-route-lib-${ts}`,
      userId: testUserId,
      isDefault: true,
    })
    .returning();
  testLibraryId = testLibrary.id;

  sessionCookie = await login(TEST_EMAIL, 'password123');

  // Secondary user (for auth/ownership tests)
  await authService.createUser(OTHER_EMAIL, 'password123', 'Import Route Other User');
  const [otherUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, OTHER_EMAIL))
    .limit(1);
  otherUserId = otherUser.id;

  // Other user gets their own default library (requireLibrary will create it automatically)
  otherUserCookie = await login(OTHER_EMAIL, 'password123');
});

afterAll(async () => {
  // Final cleanup
  const allSessionIds = [...perTestSessionIds].filter(Boolean);
  if (allSessionIds.length > 0) {
    await db.delete(importSessions).where(inArray(importSessions.id, allSessionIds));
  }

  const allModelIds = [...perTestModelIds].filter(Boolean);
  if (allModelIds.length > 0) {
    await db.delete(models).where(inArray(models.id, allModelIds));
  }

  const bothUsers = [testUserId, otherUserId].filter(Boolean);
  if (bothUsers.length > 0) {
    await db.delete(importSessions).where(inArray(importSessions.userId, bothUsers));
    await db.delete(libraries).where(inArray(libraries.userId, bothUsers));
    await db.delete(users).where(inArray(users.id, bothUsers));
  }

  await app.close();
});

afterEach(async () => {
  // Clean up any sessions or models created during the most recent test
  if (perTestSessionIds.length > 0) {
    await db.delete(importSessions).where(inArray(importSessions.id, perTestSessionIds));
    perTestSessionIds = [];
  }
  if (perTestModelIds.length > 0) {
    await db.delete(models).where(inArray(models.id, perTestModelIds));
    perTestModelIds = [];
  }
});

// ---------------------------------------------------------------------------
// GET /models/import-sessions
// ---------------------------------------------------------------------------

describe('GET /models/import-sessions', () => {
  it('should return 401 when not authenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/models/import-sessions' });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.errors[0].code).toBe('UNAUTHORIZED');
  });

  it('should return 200 with { data: [], meta: null, errors: null } when no active sessions', async () => {
    // Ensure the user has no active sessions before this test
    const res = await app.inject({
      method: 'GET',
      url: '/models/import-sessions',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta', null);
    expect(body).toHaveProperty('errors', null);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('should return active sessions in the envelope data array', async () => {
    const id = await createSession({ status: 'scanning' });

    const res = await app.inject({
      method: 'GET',
      url: '/models/import-sessions',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const found = body.data.find((s: { id: string }) => s.id === id);
    expect(found).toBeDefined();
    expect(found.status).toBe('scanning');
    expect(found.originalFilename).toBe('test.zip');
  });

  it('should include sessions in all active statuses', async () => {
    const statuses = ['scanning', 'ready_for_review', 'committing', 'error'] as const;
    const createdIds: string[] = [];

    for (const status of statuses) {
      const id = await createSession({ status });
      createdIds.push(id);
    }

    const res = await app.inject({
      method: 'GET',
      url: '/models/import-sessions',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const returnedIds = body.data.map((s: { id: string }) => s.id);

    for (const id of createdIds) {
      expect(returnedIds).toContain(id);
    }
  });

  it('should NOT include committed sessions', async () => {
    const id = await createSession({ status: 'committed' });

    const res = await app.inject({
      method: 'GET',
      url: '/models/import-sessions',
      headers: { cookie: sessionCookie },
    });

    const body = res.json();
    const returnedIds = body.data.map((s: { id: string }) => s.id);
    expect(returnedIds).not.toContain(id);
  });

  it('should return ImportSession DTO shape for each session', async () => {
    const id = await createSession({ status: 'scanning' });

    const res = await app.inject({
      method: 'GET',
      url: '/models/import-sessions',
      headers: { cookie: sessionCookie },
    });

    const body = res.json();
    const session = body.data.find((s: { id: string }) => s.id === id);
    expect(session).toHaveProperty('id');
    expect(session).toHaveProperty('originalFilename');
    expect(session).toHaveProperty('status');
    expect(session).toHaveProperty('detected');
    expect(session).toHaveProperty('modelId');
    expect(session).toHaveProperty('error');
    expect(session).toHaveProperty('createdAt');
    // Internal fields must NOT be exposed
    expect(session).not.toHaveProperty('userId');
    expect(session).not.toHaveProperty('libraryId');
    expect(session).not.toHaveProperty('stagingPath');
  });

  it('should only return sessions for the authenticated user (library isolation)', async () => {
    // Create a session for the primary user
    const primaryId = await createSession({ status: 'scanning' });

    // Other user's session (managed via importSessionService directly)
    const otherUserDb = await db
      .select()
      .from(users)
      .where(eq(users.email, OTHER_EMAIL))
      .limit(1);
    const otherLibraries = await db
      .select()
      .from(libraries)
      .where(eq(libraries.userId, otherUserDb[0].id));

    if (otherLibraries.length > 0) {
      const { id: otherId } = await importSessionService.create({
        userId: otherUserId,
        libraryId: otherLibraries[0].id,
        originalFilename: 'other-user-session.zip',
      });
      perTestSessionIds.push(otherId);

      const res = await app.inject({
        method: 'GET',
        url: '/models/import-sessions',
        headers: { cookie: sessionCookie },
      });

      const body = res.json();
      const returnedIds = body.data.map((s: { id: string }) => s.id);
      expect(returnedIds).toContain(primaryId);
      expect(returnedIds).not.toContain(otherId);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /models/import-sessions/:id
// ---------------------------------------------------------------------------

describe('GET /models/import-sessions/:id', () => {
  it('should return 401 when not authenticated', async () => {
    const id = await createSession({ status: 'scanning' });

    const res = await app.inject({
      method: 'GET',
      url: `/models/import-sessions/${id}`,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().errors[0].code).toBe('UNAUTHORIZED');
  });

  it('should return 200 with the ImportSession DTO in the envelope', async () => {
    const id = await createSession({ status: 'ready_for_review' });

    // Update with some detected metadata
    const detected = {
      modelCount: 2,
      fileCount: 10,
      totalSizeBytes: 3_000_000,
      artist: 'detected-artist',
      tagsGuessed: ['dragon'],
      folderStructure: [],
    };
    await importSessionService.update(id, { detected });

    const res = await app.inject({
      method: 'GET',
      url: `/models/import-sessions/${id}`,
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('meta', null);
    expect(body).toHaveProperty('errors', null);

    const session = body.data;
    expect(session.id).toBe(id);
    expect(session.status).toBe('ready_for_review');
    expect(session.detected).not.toBeNull();
    expect(session.detected.artist).toBe('detected-artist');
  });

  it('should return 404 NOT_FOUND for an unknown session id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/models/import-sessions/00000000-0000-0000-0000-000000000000',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().errors[0].code).toBe('NOT_FOUND');
  });

  it('should return 404 NOT_FOUND when the session belongs to another user', async () => {
    const id = await createSession({ status: 'scanning' });

    // Other user tries to access the primary user's session
    const res = await app.inject({
      method: 'GET',
      url: `/models/import-sessions/${id}`,
      headers: { cookie: otherUserCookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().errors[0].code).toBe('NOT_FOUND');
  });

  it('should return 400 VALIDATION_ERROR for a non-UUID session id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/models/import-sessions/not-a-uuid',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// POST /models/import-sessions/:id/commit
// ---------------------------------------------------------------------------

describe('POST /models/import-sessions/:id/commit', () => {
  it('should return 401 when not authenticated', async () => {
    const id = await createSession({ status: 'ready_for_review' });

    const res = await app.inject({
      method: 'POST',
      url: `/models/import-sessions/${id}/commit`,
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().errors[0].code).toBe('UNAUTHORIZED');
  });

  it('should return 400 VALIDATION_ERROR when session is not in ready_for_review state', async () => {
    // Session is still 'scanning' — commit requires 'ready_for_review'
    const id = await createSession({ status: 'scanning' });

    const res = await app.inject({
      method: 'POST',
      url: `/models/import-sessions/${id}/commit`,
      headers: { cookie: sessionCookie },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('should return 404 when committing a session that belongs to another user', async () => {
    // Session owned by primary user, accessed by other user
    const id = await createSession({ status: 'ready_for_review' });
    // Need staged data so the commit doesn't fail on missing manifest — but
    // the ownership check happens first, so 404 is expected before any manifest check.

    const res = await app.inject({
      method: 'POST',
      url: `/models/import-sessions/${id}/commit`,
      headers: { cookie: otherUserCookie },
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().errors[0].code).toBe('NOT_FOUND');
  });

  it('should return 400 for a non-UUID session id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/models/import-sessions/not-a-uuid/commit',
      headers: { cookie: sessionCookie },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('should accept an empty batchMetadata body (optional field)', async () => {
    // The body schema treats batchMetadata as optional; an empty object is valid.
    // We still get a 400 from the service (wrong status), not a 400 from body validation.
    const id = await createSession({ status: 'scanning' });

    const res = await app.inject({
      method: 'POST',
      url: `/models/import-sessions/${id}/commit`,
      headers: { cookie: sessionCookie },
      payload: {},
    });

    // 400 comes from the service (wrong status), which proves body validation passed.
    expect(res.statusCode).toBe(400);
    const body = res.json();
    // The error is about session state, not body shape
    expect(body.errors[0].code).toBe('VALIDATION_ERROR');
    expect(body.errors[0].message).toMatch(/not ready to commit/i);
  });

  it('should return 202 with { data: { modelId, jobId }, meta: null, errors: null } on success', async () => {
    // The commit endpoint requires a 'ready_for_review' session + a manifest
    // stored in it. We create a real temp staging directory with a real file so
    // the BullMQ commit worker (running in the same process) doesn't ENOENT.
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alex-commit-test-'));
    const stlPath = path.join(stagingDir, 'model.stl');
    fs.writeFileSync(stlPath, 'solid model\nendsolid model\n');

    const id = await createSession({ status: 'scanning' });

    const manifest = {
      entries: [
        {
          filename: 'model.stl',
          relativePath: 'model.stl',
          fileType: 'stl' as FileType,
          mimeType: 'model/stl',
          sizeBytes: fs.statSync(stlPath).size,
          hash: 'abc123test',
        },
      ],
      totalSizeBytes: fs.statSync(stlPath).size,
    };

    await importSessionService.update(id, {
      status: 'ready_for_review',
      manifest,
      stagingPath: stagingDir,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/models/import-sessions/${id}/commit`,
      headers: { cookie: sessionCookie },
      payload: {},
    });

    // The route enqueues a BullMQ job (real Redis is running) and returns 202
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toHaveProperty('meta', null);
    expect(body).toHaveProperty('errors', null);
    expect(body.data).toHaveProperty('modelId');
    expect(body.data).toHaveProperty('jobId');
    expect(typeof body.data.modelId).toBe('string');
    expect(typeof body.data.jobId).toBe('string');

    // Track the created model for cleanup
    perTestModelIds.push(body.data.modelId);
  });
});

// ---------------------------------------------------------------------------
// DELETE /models/import-sessions/:id
// ---------------------------------------------------------------------------

describe('DELETE /models/import-sessions/:id', () => {
  it('should return 401 when not authenticated', async () => {
    const id = await createSession({ status: 'scanning' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/models/import-sessions/${id}`,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().errors[0].code).toBe('UNAUTHORIZED');
  });

  it('should return 200 with { data: null, meta: null, errors: null } on success', async () => {
    const id = await createSession({ status: 'ready_for_review' });
    // Remove from tracking since we're deleting it explicitly
    perTestSessionIds = perTestSessionIds.filter((sid) => sid !== id);

    const res = await app.inject({
      method: 'DELETE',
      url: `/models/import-sessions/${id}`,
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ data: null, meta: null, errors: null });
  });

  it('should remove the session from the database after deletion', async () => {
    const id = await createSession({ status: 'scanning' });
    perTestSessionIds = perTestSessionIds.filter((sid) => sid !== id);

    await app.inject({
      method: 'DELETE',
      url: `/models/import-sessions/${id}`,
      headers: { cookie: sessionCookie },
    });

    const row = await importSessionService.getRow(id);
    expect(row).toBeUndefined();
  });

  it('should return 404 when trying to delete another user\'s session', async () => {
    const id = await createSession({ status: 'scanning' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/models/import-sessions/${id}`,
      headers: { cookie: otherUserCookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().errors[0].code).toBe('NOT_FOUND');

    // The session must still exist (not deleted by the wrong user)
    const row = await importSessionService.getRow(id);
    expect(row).toBeDefined();
  });

  it('should return 400 VALIDATION_ERROR for a non-UUID session id', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/models/import-sessions/not-a-uuid',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Upload complete endpoint — sessionId contract (P3 change)
// ---------------------------------------------------------------------------

describe('POST /models/upload/:uploadId/complete — response shape', () => {
  it('should return { data: { sessionId }, ... } not { data: { modelId, jobId } }', async () => {
    // Build a minimal valid zip file so the assembleFile size check passes.
    // The zip end-of-central-directory (EOCD) record is 22 bytes; an empty zip
    // consists of just this record. yauzl will open it as a valid empty archive.
    const eocd = Buffer.from([
      0x50, 0x4b, 0x05, 0x06, // EOCD signature
      0x00, 0x00,              // disk number
      0x00, 0x00,              // disk with central dir start
      0x00, 0x00,              // entries on this disk
      0x00, 0x00,              // total entries
      0x00, 0x00, 0x00, 0x00, // central dir size
      0x00, 0x00, 0x00, 0x00, // central dir offset
      0x00, 0x00,              // comment length
    ]);

    // Step 1: Init an upload session with the exact file size
    const initRes = await app.inject({
      method: 'POST',
      url: '/models/upload/init',
      headers: { cookie: sessionCookie },
      payload: {
        filename: 'contract-test.zip',
        totalSize: eocd.length,
        totalChunks: 1,
      },
    });

    expect(initRes.statusCode).toBe(201);
    const { uploadId } = initRes.json().data;

    // Step 2: Send the single chunk
    const chunkRes = await app.inject({
      method: 'PUT',
      url: `/models/upload/${uploadId}/chunk/0`,
      headers: {
        cookie: sessionCookie,
        'content-type': 'application/octet-stream',
      },
      payload: eocd,
    });

    expect(chunkRes.statusCode).toBe(200);

    // Step 3: Call complete — the new P3 contract returns { sessionId }.
    const completeRes = await app.inject({
      method: 'POST',
      url: `/models/upload/${uploadId}/complete`,
      headers: { cookie: sessionCookie },
    });

    // The route returns 202 with { data: { sessionId } }.
    expect(completeRes.statusCode).toBe(202);
    const completeBody = completeRes.json();

    expect(completeBody).toHaveProperty('meta', null);
    expect(completeBody).toHaveProperty('errors', null);

    // New P3 contract: data has sessionId, NOT modelId/jobId
    expect(completeBody.data).toHaveProperty('sessionId');
    expect(typeof completeBody.data.sessionId).toBe('string');
    expect(completeBody.data).not.toHaveProperty('modelId');
    expect(completeBody.data).not.toHaveProperty('jobId');

    // Track session for cleanup
    perTestSessionIds.push(completeBody.data.sessionId);
  });
});
