import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, libraries } from '../db/schema/index.js';
import { requireLibrary } from './library.js';
import { AppError } from '../utils/errors.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

// ---------------------------------------------------------------------------
// Test fixtures
//
// These tests require a running PostgreSQL database (DATABASE_URL in env).
// A real test user is created in beforeAll and cleaned up in afterAll.
// FK-ordered cleanup: delete libraries first, then the user.
// ---------------------------------------------------------------------------

let testUserId: string;

beforeAll(async () => {
  // Remove any leftover fixture from a previous failed run.
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'library-middleware-test@example.com'))
    .limit(1);

  if (existingUser) {
    await db.delete(libraries).where(eq(libraries.userId, existingUser.id));
    await db.delete(users).where(eq(users.id, existingUser.id));
  }

  // Create a clean test user.
  const [testUser] = await db
    .insert(users)
    .values({
      email: 'library-middleware-test@example.com',
      displayName: 'Library Middleware Test User',
      passwordHash: 'not-a-real-hash',
      role: 'user',
    })
    .returning();

  testUserId = testUser.id;
});

afterAll(async () => {
  // FK-ordered cleanup: libraries before user.
  if (testUserId) {
    await db.delete(libraries).where(eq(libraries.userId, testUserId));
    await db.delete(users).where(eq(users.id, testUserId));
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(user: FastifyRequest['user']): FastifyRequest {
  return { user, libraryId: null } as unknown as FastifyRequest;
}

const noopReply = {} as FastifyReply;

// ---------------------------------------------------------------------------
// requireLibrary()
// ---------------------------------------------------------------------------

describe('requireLibrary middleware', () => {
  it('sets request.libraryId to a non-null string when user is authenticated', async () => {
    const request = makeRequest({
      id: testUserId,
      email: 'library-middleware-test@example.com',
      displayName: 'Library Middleware Test User',
      role: 'user',
    });

    await requireLibrary(request, noopReply);

    expect(typeof request.libraryId).toBe('string');
    expect(request.libraryId).not.toBeNull();
    expect((request.libraryId as string).length).toBeGreaterThan(0);
  });

  it('returns the same libraryId on a second call (idempotent / resolveDefaultLibraryId)', async () => {
    const requestA = makeRequest({
      id: testUserId,
      email: 'library-middleware-test@example.com',
      displayName: 'Library Middleware Test User',
      role: 'user',
    });
    const requestB = makeRequest({
      id: testUserId,
      email: 'library-middleware-test@example.com',
      displayName: 'Library Middleware Test User',
      role: 'user',
    });

    await requireLibrary(requestA, noopReply);
    await requireLibrary(requestB, noopReply);

    expect(requestA.libraryId).toBe(requestB.libraryId);
  });

  it('throws an AppError (UNAUTHORIZED) when request.user is null', async () => {
    const request = makeRequest(null);

    await expect(requireLibrary(request, noopReply)).rejects.toThrow(AppError);
    await expect(requireLibrary(makeRequest(null), noopReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
