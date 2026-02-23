import { eq, and, inArray, isNull, sql, count } from 'drizzle-orm';
import type {
  Collection,
  CollectionDetail,
  CollectionSummary,
  BulkCollectionRequest,
} from '@alexandria/shared';
import { db } from '../db/index.js';
import { collections, collectionModels } from '../db/schema/index.js';
import type { Collection as CollectionRow } from '../db/schema/collection.js';
import { createLogger } from '../utils/logger.js';
import { generateSlug } from '../utils/slug.js';
import { notFound, validationError } from '../utils/errors.js';

const logger = createLogger('CollectionService');

// ---- Row-to-domain mappers ----

function toCollection(row: CollectionRow): Collection {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    userId: row.userId,
    parentCollectionId: row.parentCollectionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toCollectionSummary(row: {
  id: string;
  name: string;
  slug: string;
}): CollectionSummary {
  return { id: row.id, name: row.name, slug: row.slug };
}

export class CollectionService {
  // ---- Phase 4 compatibility methods ----

  /**
   * Find a collection by name for a user, or create it if it doesn't exist.
   * Uses case-insensitive name matching.
   * Preserved for folder import backward compatibility.
   */
  async findOrCreateByName(
    name: string,
    userId: string,
  ): Promise<{ id: string; name: string }> {
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

    const slug = generateSlug(name);
    const [created] = await db
      .insert(collections)
      .values({ name, slug, userId })
      .returning({ id: collections.id, name: collections.name });

    logger.info(
      { service: 'CollectionService', collectionId: created.id, name, slug },
      'Created collection from import pattern',
    );

    return created;
  }

  /**
   * Add a single model to a collection. Idempotent.
   * Preserved for folder import backward compatibility.
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

  // ---- Full CRUD ----

  /**
   * Create a new collection. Validates parent exists if provided.
   */
  async createCollection(
    data: { name: string; description?: string; parentCollectionId?: string },
    userId: string,
  ): Promise<Collection> {
    if (data.parentCollectionId) {
      await this._requireCollection(data.parentCollectionId);
    }

    const slug = generateSlug(data.name);
    const [row] = await db
      .insert(collections)
      .values({
        name: data.name,
        slug,
        description: data.description ?? null,
        userId,
        parentCollectionId: data.parentCollectionId ?? null,
      })
      .returning();

    logger.info(
      { service: 'CollectionService', collectionId: row.id, name: row.name, slug },
      'Collection created',
    );

    return toCollection(row);
  }

  /**
   * Fetch a collection by ID or throw NOT_FOUND.
   */
  async getCollectionById(id: string): Promise<Collection> {
    const row = await this._requireCollection(id);
    return toCollection(row);
  }

  /**
   * Fetch a collection with its children summaries and model count.
   */
  async getCollectionDetail(id: string): Promise<CollectionDetail> {
    const row = await this._requireCollection(id);

    const childRows = await db
      .select({ id: collections.id, name: collections.name, slug: collections.slug })
      .from(collections)
      .where(eq(collections.parentCollectionId, id));

    const [{ value: modelCount }] = await db
      .select({ value: count() })
      .from(collectionModels)
      .where(eq(collectionModels.collectionId, id));

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      parentCollectionId: row.parentCollectionId,
      children: childRows.map(toCollectionSummary),
      modelCount: Number(modelCount),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * List top-level collections for a user. Loads children to the specified depth
   * (default 1 — returns summaries of direct children only, no recursion).
   */
  async listCollections(
    userId: string,
    params: { depth?: number } = {},
  ): Promise<CollectionDetail[]> {
    const depth = params.depth ?? 1;

    const topLevel = await db
      .select()
      .from(collections)
      .where(and(eq(collections.userId, userId), isNull(collections.parentCollectionId)))
      .orderBy(collections.createdAt);

    if (topLevel.length === 0) {
      return [];
    }

    const topLevelIds = topLevel.map((c) => c.id);
    const modelCounts = await this._getModelCounts(topLevelIds);

    const results: CollectionDetail[] = [];
    for (const row of topLevel) {
      const children = await this._loadChildren(row.id);
      results.push({
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        parentCollectionId: row.parentCollectionId,
        children,
        modelCount: modelCounts.get(row.id) ?? 0,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    }

    return results;
  }

  /**
   * Update a collection's name, description, or parent. Prevents circular references.
   */
  async updateCollection(
    id: string,
    data: { name?: string; description?: string | null; parentCollectionId?: string | null },
  ): Promise<Collection> {
    await this._requireCollection(id);

    if (data.parentCollectionId !== undefined) {
      if (data.parentCollectionId !== null) {
        // Validate the proposed parent exists
        await this._requireCollection(data.parentCollectionId);
        // Guard against circular nesting
        await this._assertNoCircularReference(id, data.parentCollectionId);
      }
    }

    const updateValues: Partial<{
      name: string;
      slug: string;
      description: string | null;
      parentCollectionId: string | null;
      updatedAt: Date;
    }> = { updatedAt: new Date() };

    if (data.name !== undefined) {
      updateValues.name = data.name;
      updateValues.slug = generateSlug(data.name);
    }
    if (data.description !== undefined) {
      updateValues.description = data.description;
    }
    if (data.parentCollectionId !== undefined) {
      updateValues.parentCollectionId = data.parentCollectionId;
    }

    const [updated] = await db
      .update(collections)
      .set(updateValues)
      .where(eq(collections.id, id))
      .returning();

    logger.info(
      { service: 'CollectionService', collectionId: id },
      'Collection updated',
    );

    return toCollection(updated);
  }

  /**
   * Delete a collection. The DB schema handles:
   * - children: SET NULL on parentCollectionId (they become top-level)
   * - memberships: CASCADE delete from collection_models
   * Models themselves are NOT deleted.
   */
  async deleteCollection(id: string): Promise<void> {
    await this._requireCollection(id);

    await db.delete(collections).where(eq(collections.id, id));

    logger.info(
      { service: 'CollectionService', collectionId: id },
      'Collection deleted',
    );
  }

  // ---- Model membership ----

  /**
   * Add multiple models to a collection. Idempotent — ignores duplicates.
   */
  async addModelsToCollection(collectionId: string, modelIds: string[]): Promise<void> {
    await this._requireCollection(collectionId);

    if (modelIds.length === 0) {
      return;
    }

    await db
      .insert(collectionModels)
      .values(modelIds.map((modelId) => ({ collectionId, modelId })))
      .onConflictDoNothing();

    logger.info(
      { service: 'CollectionService', collectionId, count: modelIds.length },
      'Models added to collection',
    );
  }

  /**
   * Remove a single model from a collection.
   */
  async removeModelFromCollection(collectionId: string, modelId: string): Promise<void> {
    await this._requireCollection(collectionId);

    await db
      .delete(collectionModels)
      .where(
        and(
          eq(collectionModels.collectionId, collectionId),
          eq(collectionModels.modelId, modelId),
        ),
      );

    logger.info(
      { service: 'CollectionService', collectionId, modelId },
      'Model removed from collection',
    );
  }

  /**
   * Bulk add or remove models from a collection.
   */
  async bulkCollectionOperation(data: BulkCollectionRequest): Promise<void> {
    if (data.action === 'add') {
      await this.addModelsToCollection(data.collectionId, data.modelIds);
    } else {
      await this._requireCollection(data.collectionId);

      if (data.modelIds.length === 0) {
        return;
      }

      await db
        .delete(collectionModels)
        .where(
          and(
            eq(collectionModels.collectionId, data.collectionId),
            inArray(collectionModels.modelId, data.modelIds),
          ),
        );

      logger.info(
        { service: 'CollectionService', collectionId: data.collectionId, count: data.modelIds.length },
        'Models removed from collection (bulk)',
      );
    }
  }

  // ---- Private helpers ----

  /**
   * Fetch a collection row by ID or throw NOT_FOUND.
   */
  private async _requireCollection(id: string): Promise<CollectionRow> {
    const [row] = await db
      .select()
      .from(collections)
      .where(eq(collections.id, id))
      .limit(1);

    if (!row) {
      throw notFound(`Collection not found: ${id}`);
    }

    return row;
  }

  /**
   * Load direct children of a collection as CollectionSummary[].
   * CollectionDetail.children is typed as CollectionSummary[], which cannot
   * carry nested data, so we only load direct children regardless of depth.
   */
  private async _loadChildren(parentId: string): Promise<CollectionSummary[]> {
    const rows = await db
      .select({ id: collections.id, name: collections.name, slug: collections.slug })
      .from(collections)
      .where(eq(collections.parentCollectionId, parentId))
      .orderBy(collections.createdAt);

    return rows.map(toCollectionSummary);
  }

  /**
   * Fetch model counts for a set of collection IDs in one query.
   */
  private async _getModelCounts(collectionIds: string[]): Promise<Map<string, number>> {
    if (collectionIds.length === 0) {
      return new Map();
    }

    const rows = await db
      .select({
        collectionId: collectionModels.collectionId,
        value: count(),
      })
      .from(collectionModels)
      .where(inArray(collectionModels.collectionId, collectionIds))
      .groupBy(collectionModels.collectionId);

    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.collectionId, Number(row.value));
    }
    return map;
  }

  /**
   * Walk the ancestor chain from proposedParentId upward.
   * If we encounter targetId at any level, the move would create a cycle.
   */
  private async _assertNoCircularReference(
    targetId: string,
    proposedParentId: string,
  ): Promise<void> {
    let currentId: string | null = proposedParentId;

    while (currentId !== null) {
      if (currentId === targetId) {
        throw validationError(
          'Cannot set parent: the proposed parent is a descendant of this collection',
          'parentCollectionId',
        );
      }

      const [row] = await db
        .select({ parentCollectionId: collections.parentCollectionId })
        .from(collections)
        .where(eq(collections.id, currentId))
        .limit(1);

      if (!row) {
        // Parent no longer exists — stop walking
        break;
      }

      currentId = row.parentCollectionId;
    }
  }
}

export const collectionService = new CollectionService();
