/**
 * Integration tests for ImportSessionService (P3 staged upload).
 *
 * Tests hit the real Postgres test database. All fixture rows are inserted
 * in beforeAll and cleaned up in afterAll. No mocking — every DB call is real.
 *
 * Coverage:
 * - create()     — inserts a row with status='scanning' and returns the id.
 * - getRow()     — retrieves the raw row; returns undefined for unknown id.
 * - getOwnedRow() — throws NOT_FOUND for unknown id or wrong user.
 * - listActive() — returns only active-status sessions for the given user+library.
 * - update()     — updates status, detected, manifest, stagingPath, modelId, error.
 * - toDto()      — shape (id, originalFilename, status, detected, modelId, error, createdAt ISO).
 * - delete()     — removes the row.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, libraries, importSessions } from '../db/schema/index.js';
import { importSessionService, ImportSessionService } from './import-session.service.js';
import type { DetectedImportMetadata } from '@alexandria/shared';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let testUserId: string;
let otherUserId: string;
let testLibraryId: string;
let otherLibraryId: string;

const SESSION_EMAIL = 'import-session-test@example.com';
const OTHER_EMAIL = 'import-session-other@example.com';

// IDs created per-test (for tests that need per-test isolation)
let perTestSessionIds: string[] = [];

beforeAll(async () => {
  const ts = Date.now();

  // ------------------------------------------------------------------
  // Remove any leftovers from a previous failed run
  // ------------------------------------------------------------------
  for (const email of [SESSION_EMAIL, OTHER_EMAIL]) {
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

  // ------------------------------------------------------------------
  // Create primary test user + library
  // ------------------------------------------------------------------
  const [testUser] = await db
    .insert(users)
    .values({
      email: SESSION_EMAIL,
      displayName: 'Import Session Test User',
      passwordHash: 'not-a-real-hash',
      role: 'user',
    })
    .returning();

  testUserId = testUser.id;

  const [testLibrary] = await db
    .insert(libraries)
    .values({
      name: 'Import Session Test Library',
      slug: `import-session-lib-${ts}`,
      userId: testUserId,
      isDefault: true,
    })
    .returning();

  testLibraryId = testLibrary.id;

  // ------------------------------------------------------------------
  // Create secondary user + library (for ownership checks)
  // ------------------------------------------------------------------
  const [otherUser] = await db
    .insert(users)
    .values({
      email: OTHER_EMAIL,
      displayName: 'Import Session Other User',
      passwordHash: 'not-a-real-hash',
      role: 'user',
    })
    .returning();

  otherUserId = otherUser.id;

  const [otherLibrary] = await db
    .insert(libraries)
    .values({
      name: 'Import Session Other Library',
      slug: `import-session-other-lib-${ts}`,
      userId: otherUserId,
      isDefault: true,
    })
    .returning();

  otherLibraryId = otherLibrary.id;
});

afterAll(async () => {
  // Clean up any stray sessions created during tests
  if (perTestSessionIds.length > 0) {
    await db.delete(importSessions).where(inArray(importSessions.id, perTestSessionIds));
  }

  // Delete all sessions for both users, then libraries, then users.
  const bothUsers = [testUserId, otherUserId].filter(Boolean);
  if (bothUsers.length > 0) {
    await db.delete(importSessions).where(inArray(importSessions.userId, bothUsers));
    await db.delete(libraries).where(inArray(libraries.userId, bothUsers));
    await db.delete(users).where(inArray(users.id, bothUsers));
  }
});

/** Track a session id so afterEach / afterAll can clean it up. */
function track(id: string): string {
  perTestSessionIds.push(id);
  return id;
}

afterEach(async () => {
  // Clean up any sessions created during the most recent test
  if (perTestSessionIds.length > 0) {
    await db.delete(importSessions).where(inArray(importSessions.id, perTestSessionIds));
    perTestSessionIds = [];
  }
});

// ---------------------------------------------------------------------------
// describe: create()
// ---------------------------------------------------------------------------

describe('ImportSessionService.create()', () => {
  it('should create a session row with status scanning and return its id', async () => {
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'my-model.zip',
    });
    track(id);

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    // Verify the actual DB row
    const row = await importSessionService.getRow(id);
    expect(row).toBeDefined();
    expect(row!.userId).toBe(testUserId);
    expect(row!.libraryId).toBe(testLibraryId);
    expect(row!.originalFilename).toBe('my-model.zip');
    expect(row!.status).toBe('scanning');
    expect(row!.detected).toBeNull();
    expect(row!.modelId).toBeNull();
    expect(row!.error).toBeNull();
  });

  it('should set expiresAt to ~24 hours in the future', async () => {
    const before = Date.now();
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'test.zip',
    });
    track(id);

    const row = await importSessionService.getRow(id);
    expect(row!.expiresAt).toBeDefined();

    const expiresMs = row!.expiresAt!.getTime();
    const twentyThreeHoursMs = 23 * 60 * 60 * 1000;
    const twentyFiveHoursMs = 25 * 60 * 60 * 1000;

    expect(expiresMs).toBeGreaterThan(before + twentyThreeHoursMs);
    expect(expiresMs).toBeLessThan(before + twentyFiveHoursMs);
  });
});

// ---------------------------------------------------------------------------
// describe: getRow()
// ---------------------------------------------------------------------------

describe('ImportSessionService.getRow()', () => {
  it('should return the row when the id exists', async () => {
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'dragon.zip',
    });
    track(id);

    const row = await importSessionService.getRow(id);
    expect(row).toBeDefined();
    expect(row!.id).toBe(id);
  });

  it('should return undefined for an unknown id', async () => {
    const row = await importSessionService.getRow('00000000-0000-0000-0000-000000000000');
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// describe: getOwnedRow()
// ---------------------------------------------------------------------------

describe('ImportSessionService.getOwnedRow()', () => {
  it('should return the row when id and userId match', async () => {
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'owned.zip',
    });
    track(id);

    const row = await importSessionService.getOwnedRow(id, testUserId);
    expect(row.id).toBe(id);
    expect(row.userId).toBe(testUserId);
  });

  it('should throw NOT_FOUND when the session id does not exist', async () => {
    await expect(
      importSessionService.getOwnedRow('00000000-0000-0000-0000-000000000000', testUserId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('should throw NOT_FOUND when the session belongs to a different user', async () => {
    // Create session as the primary user
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'private.zip',
    });
    track(id);

    // Attempt to get it as the OTHER user
    await expect(
      importSessionService.getOwnedRow(id, otherUserId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// describe: listActive()
// ---------------------------------------------------------------------------

describe('ImportSessionService.listActive()', () => {
  it('should return only active sessions for the given user and library', async () => {
    // Insert one session in each of the active statuses
    const activeStatuses = ['scanning', 'ready_for_review', 'committing', 'error'] as const;
    const insertedIds: string[] = [];

    for (const status of activeStatuses) {
      const { id } = await importSessionService.create({
        userId: testUserId,
        libraryId: testLibraryId,
        originalFilename: `${status}.zip`,
      });
      track(id);
      insertedIds.push(id);

      if (status !== 'scanning') {
        // update to the target status
        await importSessionService.update(id, { status });
      }
    }

    const list = await importSessionService.listActive(testUserId, testLibraryId);
    const listIds = list.map((s) => s.id);

    for (const id of insertedIds) {
      expect(listIds).toContain(id);
    }
  });

  it('should NOT return committed sessions in the active list', async () => {
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'committed.zip',
    });
    track(id);

    await importSessionService.update(id, { status: 'committed' });

    const list = await importSessionService.listActive(testUserId, testLibraryId);
    const listIds = list.map((s) => s.id);
    expect(listIds).not.toContain(id);
  });

  it('should NOT return sessions belonging to a different user', async () => {
    // Session for the OTHER user in the OTHER library
    const { id } = await importSessionService.create({
      userId: otherUserId,
      libraryId: otherLibraryId,
      originalFilename: 'other-user.zip',
    });
    track(id);

    const list = await importSessionService.listActive(testUserId, testLibraryId);
    const listIds = list.map((s) => s.id);
    expect(listIds).not.toContain(id);
  });

  it('should NOT return sessions from a different library for the same user', async () => {
    // We need a second library for the same test user to test this
    const ts = Date.now();
    const [lib2] = await db
      .insert(libraries)
      .values({
        name: 'Second Library',
        slug: `import-session-lib2-${ts}`,
        userId: testUserId,
        isDefault: false,
      })
      .returning();

    try {
      const { id } = await importSessionService.create({
        userId: testUserId,
        libraryId: lib2.id,
        originalFilename: 'wrong-library.zip',
      });
      track(id);

      const list = await importSessionService.listActive(testUserId, testLibraryId);
      const listIds = list.map((s) => s.id);
      expect(listIds).not.toContain(id);
    } finally {
      await db.delete(libraries).where(eq(libraries.id, lib2.id));
    }
  });

  it('should return sessions in descending createdAt order', async () => {
    const id1 = track(
      (
        await importSessionService.create({
          userId: testUserId,
          libraryId: testLibraryId,
          originalFilename: 'first.zip',
        })
      ).id,
    );

    const id2 = track(
      (
        await importSessionService.create({
          userId: testUserId,
          libraryId: testLibraryId,
          originalFilename: 'second.zip',
        })
      ).id,
    );

    const list = await importSessionService.listActive(testUserId, testLibraryId);
    const listIds = list.map((s) => s.id);

    const idx1 = listIds.indexOf(id1);
    const idx2 = listIds.indexOf(id2);
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThanOrEqual(0);
    // id2 was created later so it should appear before id1 (desc order)
    expect(idx2).toBeLessThan(idx1);
  });
});

// ---------------------------------------------------------------------------
// describe: update()
// ---------------------------------------------------------------------------

describe('ImportSessionService.update()', () => {
  it('should update the status field', async () => {
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'update-status.zip',
    });
    track(id);

    await importSessionService.update(id, { status: 'ready_for_review' });

    const row = await importSessionService.getRow(id);
    expect(row!.status).toBe('ready_for_review');
  });

  it('should store detected metadata as JSON', async () => {
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'update-detected.zip',
    });
    track(id);

    const detected: DetectedImportMetadata = {
      modelCount: 3,
      fileCount: 12,
      totalSizeBytes: 5_000_000,
      artist: 'test-artist',
      tagsGuessed: ['dragon', 'fantasy'],
      folderStructure: [
        { name: 'models', type: 'folder', children: [{ name: 'dragon.stl', type: 'file', fileType: 'stl' }] },
      ],
    };

    await importSessionService.update(id, { status: 'ready_for_review', detected });

    const row = await importSessionService.getRow(id);
    expect(row!.status).toBe('ready_for_review');

    const storedDetected = row!.detected as DetectedImportMetadata;
    expect(storedDetected.modelCount).toBe(3);
    expect(storedDetected.fileCount).toBe(12);
    expect(storedDetected.artist).toBe('test-artist');
    expect(storedDetected.tagsGuessed).toEqual(['dragon', 'fantasy']);
    expect(storedDetected.folderStructure).toHaveLength(1);
  });

  it('should update stagingPath field', async () => {
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'staging.zip',
    });
    track(id);

    await importSessionService.update(id, { stagingPath: '/tmp/staging/session-xyz' });

    const row = await importSessionService.getRow(id);
    expect(row!.stagingPath).toBe('/tmp/staging/session-xyz');
  });

  it('should update error field', async () => {
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'error.zip',
    });
    track(id);

    await importSessionService.update(id, { status: 'error', error: 'Archive is corrupt' });

    const row = await importSessionService.getRow(id);
    expect(row!.status).toBe('error');
    expect(row!.error).toBe('Archive is corrupt');
  });

  it('should update updatedAt on each call', async () => {
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'updated-at.zip',
    });
    track(id);

    const before = await importSessionService.getRow(id);
    const updatedAtBefore = before!.updatedAt.getTime();

    // Ensure at least 1ms passes
    await new Promise((r) => setTimeout(r, 5));
    await importSessionService.update(id, { status: 'ready_for_review' });

    const after = await importSessionService.getRow(id);
    const updatedAtAfter = after!.updatedAt.getTime();

    expect(updatedAtAfter).toBeGreaterThanOrEqual(updatedAtBefore);
  });
});

// ---------------------------------------------------------------------------
// describe: toDto()
// ---------------------------------------------------------------------------

describe('ImportSessionService.toDto()', () => {
  it('should map a raw row to an ImportSession DTO with correct shape', async () => {
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'dto-test.zip',
    });
    track(id);

    const row = await importSessionService.getRow(id);
    const service = new ImportSessionService();
    const dto = service.toDto(row!);

    expect(dto).toHaveProperty('id', id);
    expect(dto).toHaveProperty('originalFilename', 'dto-test.zip');
    expect(dto).toHaveProperty('status', 'scanning');
    expect(dto).toHaveProperty('detected', null);
    expect(dto).toHaveProperty('modelId', null);
    expect(dto).toHaveProperty('commitProgress', null);
    expect(dto).toHaveProperty('error', null);
    expect(dto).toHaveProperty('createdAt');

    // createdAt must be an ISO-8601 string
    expect(typeof dto.createdAt).toBe('string');
    expect(new Date(dto.createdAt).toISOString()).toBe(dto.createdAt);

    // DTO must NOT expose internal fields like userId, libraryId, stagingPath, manifest
    expect(dto).not.toHaveProperty('userId');
    expect(dto).not.toHaveProperty('libraryId');
    expect(dto).not.toHaveProperty('stagingPath');
    expect(dto).not.toHaveProperty('manifest');
  });

  it('should include detected metadata in the DTO when populated', async () => {
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'dto-detected.zip',
    });
    track(id);

    const detected: DetectedImportMetadata = {
      modelCount: 1,
      fileCount: 5,
      totalSizeBytes: 1_000_000,
      artist: null,
      tagsGuessed: [],
      folderStructure: [],
    };

    await importSessionService.update(id, { status: 'ready_for_review', detected });

    const row = await importSessionService.getRow(id);
    const service = new ImportSessionService();
    const dto = service.toDto(row!);

    expect(dto.status).toBe('ready_for_review');
    expect(dto.detected).not.toBeNull();
    expect(dto.detected!.modelCount).toBe(1);
    expect(dto.detected!.fileCount).toBe(5);
  });

  it('should expose validated commit progress only while committing', async () => {
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'dto-progress.zip',
    });
    track(id);
    await importSessionService.update(id, { status: 'committing' });

    const row = await importSessionService.getRow(id);
    const progress = {
      phase: 'storing_files' as const,
      percent: 40,
      completedFiles: 1,
      totalFiles: 2,
      completedBytes: 50,
      totalBytes: 100,
      currentFilename: 'model.stl',
    };
    const service = new ImportSessionService();

    expect(service.toDto(row!, progress).commitProgress).toEqual(progress);
    expect(service.toDto({ ...row!, status: 'ready_for_review' }, progress).commitProgress).toBeNull();
  });

  it('should use queued totals until BullMQ publishes structured commit progress', async () => {
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'dto-queued.zip',
    });
    track(id);
    await importSessionService.update(id, {
      status: 'committing',
      detected: {
        modelCount: 1,
        fileCount: 4,
        totalSizeBytes: 1234,
        artist: null,
        tagsGuessed: [],
        folderStructure: [],
      },
    });
    const progressSource = { getImportCommitProgress: vi.fn().mockResolvedValue(null) };
    const service = new ImportSessionService(progressSource);

    const dto = await service.getOwnedSession(id, testUserId);

    expect(dto.commitProgress).toEqual({
      phase: 'queued',
      percent: 0,
      completedFiles: 0,
      totalFiles: 4,
      completedBytes: 0,
      totalBytes: 1234,
      currentFilename: null,
    });
    expect(progressSource.getImportCommitProgress).toHaveBeenCalledWith(id);
  });

  it('should preserve the session response when commit progress lookup fails', async () => {
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'dto-progress-failure.zip',
    });
    track(id);
    await importSessionService.update(id, { status: 'committing' });
    const service = new ImportSessionService({
      getImportCommitProgress: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
    });

    await expect(service.getOwnedSession(id, testUserId)).resolves.toMatchObject({
      id,
      status: 'committing',
      commitProgress: {
        phase: 'queued',
        percent: 0,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// describe: delete()
// ---------------------------------------------------------------------------

describe('ImportSessionService.delete()', () => {
  it('should remove the session row from the database', async () => {
    const { id } = await importSessionService.create({
      userId: testUserId,
      libraryId: testLibraryId,
      originalFilename: 'to-delete.zip',
    });
    // Don't track — we're deleting it explicitly in the test

    // Confirm it exists
    const before = await importSessionService.getRow(id);
    expect(before).toBeDefined();

    await importSessionService.delete(id);

    const after = await importSessionService.getRow(id);
    expect(after).toBeUndefined();
  });

  it('should be idempotent — deleting a non-existent session does not throw', async () => {
    await expect(
      importSessionService.delete('00000000-0000-0000-0000-000000000000'),
    ).resolves.not.toThrow();
  });
});
