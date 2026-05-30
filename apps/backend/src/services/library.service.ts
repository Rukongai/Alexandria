import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { libraries } from '../db/schema/index.js';
import { generateSlug } from '../utils/slug.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('LibraryService');

/**
 * LibraryService — resolves the library scope that models and collections
 * belong to. Every model/collection requires a libraryId (NOT NULL since
 * migration 0007); the invariant established by the migration backfill is that
 * every user has exactly one default library.
 *
 * This service is intentionally minimal: it resolves (and lazily creates, for
 * users that post-date the backfill) a user's default library. Full library
 * management (multiple libraries, switching, renaming) is a later workspace task.
 */
export class LibraryService {
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
}

export const libraryService = new LibraryService();
