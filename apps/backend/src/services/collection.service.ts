import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { collections, collectionModels } from '../db/schema/index.js';
import { createLogger } from '../utils/logger.js';
import { generateSlug } from '../utils/slug.js';

const logger = createLogger('CollectionService');

/**
 * Minimal CollectionService for Phase 4 (folder import).
 * Provides find-or-create by name and add model to collection.
 * Phase 6 will extend with full CRUD, nesting, tree operations.
 */
export class CollectionService {
  /**
   * Find a collection by name for a user, or create it if it doesn't exist.
   * Uses case-insensitive name matching.
   */
  async findOrCreateByName(
    name: string,
    userId: string,
  ): Promise<{ id: string; name: string }> {
    // Try to find existing collection by name (case-insensitive)
    const [existing] = await db
      .select({ id: collections.id, name: collections.name })
      .from(collections)
      .where(
        and(
          sql`lower(${collections.name}) = lower(${name})`,
          eq(collections.userId, userId),
        ),
      )
      .limit(1);

    if (existing) {
      return existing;
    }

    // Create new collection
    const slug = generateSlug(name);
    const [created] = await db
      .insert(collections)
      .values({
        name,
        slug,
        userId,
      })
      .returning({ id: collections.id, name: collections.name });

    logger.info(
      { collectionId: created.id, name, slug },
      'Created collection from import pattern',
    );

    return created;
  }

  /**
   * Add a model to a collection. Ignores if already a member (idempotent).
   */
  async addModelToCollection(
    collectionId: string,
    modelId: string,
  ): Promise<void> {
    await db
      .insert(collectionModels)
      .values({ collectionId, modelId })
      .onConflictDoNothing();
  }
}

export const collectionService = new CollectionService();
