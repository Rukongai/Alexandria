import { and, eq, asc, desc, count, inArray } from 'drizzle-orm';
import type {
  LibrarySummary,
  CreateLibraryRequest,
  UpdateLibraryRequest,
} from '@alexandria/shared';
import { db } from '../db/index.js';
import { libraries, models, collections } from '../db/schema/index.js';
import type { Library as LibraryRow } from '../db/schema/library.js';
import { generateSlug } from '../utils/slug.js';
import { createLogger } from '../utils/logger.js';
import { notFound, conflict } from '../utils/errors.js';

const logger = createLogger('LibraryService');

/**
 * LibraryService — owns the library scope that models and collections belong to.
 * Every model/collection requires a libraryId (NOT NULL since migration 0007);
 * the invariant established by the 0006 backfill is that every user has exactly
 * one default library.
 *
 * P5 surfaces multiple libraries to the user: this service resolves the active
 * scope (validated against ownership) and provides the management CRUD that the
 * All-Libraries home and rail switcher drive. libraryId is never accepted from
 * untrusted input without an ownership check.
 */
export class LibraryService {
  // ---- Scope resolution (used by the requireLibrary middleware) ----

  /**
   * Return the id of the user's default library, creating one if none exists.
   * Mirrors the 0006 backfill invariant: one default library per user.
   */
  async resolveDefaultLibraryId(userId: string): Promise<string> {
    const [existing] = await db
      .select({ id: libraries.id })
      .from(libraries)
      .where(and(eq(libraries.userId, userId), eq(libraries.isDefault, true)))
      .limit(1);

    if (existing) {
      return existing.id;
    }

    // No default library yet (user created after the backfill). Create one,
    // matching the naming the backfill migration used.
    const [created] = await db
      .insert(libraries)
      .values({
        name: 'Library',
        slug: generateSlug('library'),
        userId,
        isDefault: true,
      })
      .returning({ id: libraries.id });

    logger.info(
      { service: 'LibraryService', userId, libraryId: created.id },
      'Created default library for user',
    );

    return created.id;
  }

  /**
   * Resolve the active library for a request. If `requestedId` is provided it
   * MUST belong to the user — otherwise NOT_FOUND (same error whether it does
   * not exist or belongs to someone else, so ids cannot be enumerated). When no
   * id is requested, fall back to the user's default library.
   */
  async resolveLibraryId(userId: string, requestedId?: string | null): Promise<string> {
    if (requestedId) {
      await this.requireOwnedLibrary(userId, requestedId);
      return requestedId;
    }
    return this.resolveDefaultLibraryId(userId);
  }

  /**
   * Verify a library exists and belongs to the user. Throws NOT_FOUND otherwise.
   */
  async requireOwnedLibrary(userId: string, libraryId: string): Promise<LibraryRow> {
    const [row] = await db
      .select()
      .from(libraries)
      .where(and(eq(libraries.id, libraryId), eq(libraries.userId, userId)))
      .limit(1);

    if (!row) {
      throw notFound('Library not found');
    }
    return row;
  }

  // ---- Management CRUD (drives the All-Libraries home + switcher) ----

  /**
   * List a user's libraries with derived model/collection counts, default first
   * then oldest first. Counts come from two grouped queries rather than N+1.
   */
  async listLibraries(userId: string): Promise<LibrarySummary[]> {
    const rows = await db
      .select()
      .from(libraries)
      .where(eq(libraries.userId, userId))
      .orderBy(desc(libraries.isDefault), asc(libraries.createdAt));

    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((r) => r.id);
    const [modelCounts, collectionCounts] = await Promise.all([
      this._countModelsByLibrary(ids),
      this._countCollectionsByLibrary(ids),
    ]);

    return rows.map((row) => ({
      ...toLibrary(row),
      modelCount: modelCounts.get(row.id) ?? 0,
      collectionCount: collectionCounts.get(row.id) ?? 0,
    }));
  }

  /**
   * Create a new (non-default) library for the user.
   */
  async createLibrary(userId: string, data: CreateLibraryRequest): Promise<LibrarySummary> {
    const [row] = await db
      .insert(libraries)
      .values({
        name: data.name,
        slug: generateSlug(data.name),
        userId,
        isDefault: false,
        ...(data.color ? { color: data.color } : {}),
      })
      .returning();

    logger.info(
      { service: 'LibraryService', userId, libraryId: row.id, name: row.name },
      'Library created',
    );

    return { ...toLibrary(row), modelCount: 0, collectionCount: 0 };
  }

  /**
   * Rename / recolor a library. Renaming regenerates the slug.
   */
  async updateLibrary(
    userId: string,
    libraryId: string,
    data: UpdateLibraryRequest,
  ): Promise<LibrarySummary> {
    await this.requireOwnedLibrary(userId, libraryId);

    const updateValues: Partial<{ name: string; slug: string; color: string; updatedAt: Date }> = {
      updatedAt: new Date(),
    };
    if (data.name !== undefined) {
      updateValues.name = data.name;
      updateValues.slug = generateSlug(data.name);
    }
    if (data.color !== undefined) {
      updateValues.color = data.color;
    }

    const [updated] = await db
      .update(libraries)
      .set(updateValues)
      .where(eq(libraries.id, libraryId))
      .returning();

    logger.info({ service: 'LibraryService', userId, libraryId }, 'Library updated');

    const [modelCount, collectionCount] = await this._countContents(libraryId);
    return { ...toLibrary(updated), modelCount, collectionCount };
  }

  /**
   * Mark a library as the user's default. Clears the prior default and sets the
   * new one in a single transaction so the partial unique index never sees two
   * defaults mid-flip.
   */
  async setDefaultLibrary(userId: string, libraryId: string): Promise<void> {
    await this.requireOwnedLibrary(userId, libraryId);

    await db.transaction(async (tx) => {
      await tx
        .update(libraries)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(libraries.userId, userId), eq(libraries.isDefault, true)));
      await tx
        .update(libraries)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(libraries.id, libraryId));
    });

    logger.info({ service: 'LibraryService', userId, libraryId }, 'Default library changed');
  }

  /**
   * Delete a library. Refuses when it is the default, the user's only library,
   * or still owns models or collections (the FK is ON DELETE no action; we
   * surface a clear 409 rather than a raw constraint error).
   */
  async deleteLibrary(userId: string, libraryId: string): Promise<void> {
    const row = await this.requireOwnedLibrary(userId, libraryId);

    if (row.isDefault) {
      throw conflict('Cannot delete the default library. Set another library as default first.');
    }

    const [{ value: total }] = await db
      .select({ value: count() })
      .from(libraries)
      .where(eq(libraries.userId, userId));
    if (Number(total) <= 1) {
      throw conflict('Cannot delete your only library.');
    }

    const [modelCount, collectionCount] = await this._countContents(libraryId);
    if (modelCount > 0 || collectionCount > 0) {
      throw conflict(
        'Cannot delete a library that still contains models or collections. Move or delete its contents first.',
      );
    }

    await db.delete(libraries).where(eq(libraries.id, libraryId));

    logger.info({ service: 'LibraryService', userId, libraryId }, 'Library deleted');
  }

  // ---- Private helpers ----

  private async _countModelsByLibrary(libraryIds: string[]): Promise<Map<string, number>> {
    const rows = await db
      .select({ libraryId: models.libraryId, value: count() })
      .from(models)
      .where(inArray(models.libraryId, libraryIds))
      .groupBy(models.libraryId);
    return toCountMap(rows);
  }

  private async _countCollectionsByLibrary(libraryIds: string[]): Promise<Map<string, number>> {
    const rows = await db
      .select({ libraryId: collections.libraryId, value: count() })
      .from(collections)
      .where(inArray(collections.libraryId, libraryIds))
      .groupBy(collections.libraryId);
    return toCountMap(rows);
  }

  /** Returns [modelCount, collectionCount] for a single library. */
  private async _countContents(libraryId: string): Promise<[number, number]> {
    const [[m], [c]] = await Promise.all([
      db.select({ value: count() }).from(models).where(eq(models.libraryId, libraryId)),
      db.select({ value: count() }).from(collections).where(eq(collections.libraryId, libraryId)),
    ]);
    return [Number(m.value), Number(c.value)];
  }
}

function toCountMap(rows: { libraryId: string; value: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.libraryId, Number(row.value));
  }
  return map;
}

function toLibrary(row: LibraryRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    userId: row.userId,
    isDefault: row.isDefault,
    color: row.color,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const libraryService = new LibraryService();
