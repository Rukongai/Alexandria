import { and, eq, SQL } from 'drizzle-orm';
import type {
  SmartCollection,
  SmartCollectionDetail,
  CreateSmartCollectionRequest,
  UpdateSmartCollectionRequest,
  RuleNode,
  ModelSearchParams,
} from '@alexandria/shared';
import { LEGAL_OPERATORS_BY_METADATA_TYPE } from '@alexandria/shared';
import { db } from '../db/index.js';
import { smartCollections } from '../db/schema/index.js';
import type { SmartCollection as SmartCollectionRow } from '../db/schema/smart-collection.js';
import { searchService, type SearchResult } from './search.service.js';
import { metadataService } from './metadata.service.js';
import { compileRuleTree, collectConditions } from './rule-engine.js';
import { createLogger } from '../utils/logger.js';
import { generateSlug } from '../utils/slug.js';
import { notFound, validationError } from '../utils/errors.js';

const logger = createLogger('SmartCollectionService');

/** The result of validating + compiling a rule tree, ready for searchModels. */
interface CompiledRules {
  ruleWhere: SQL | undefined;
  /** False when the tree references status, so searchModels skips its ready default. */
  applyDefaultStatus: boolean;
}

function toEntity(row: SmartCollectionRow): SmartCollection {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    definition: row.definition,
    userId: row.userId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class SmartCollectionService {
  /**
   * Verify a smart collection exists, belongs to the user, and is in the
   * library. Returns the row. Throws NOT_FOUND if any check fails — same error
   * shape regardless of which, so IDs cannot be enumerated.
   */
  async requireOwnedSmartCollection(
    id: string,
    userId: string,
    libraryId: string,
  ): Promise<SmartCollectionRow> {
    const [row] = await db
      .select()
      .from(smartCollections)
      .where(
        and(
          eq(smartCollections.id, id),
          eq(smartCollections.userId, userId),
          eq(smartCollections.libraryId, libraryId),
        ),
      )
      .limit(1);

    if (!row) {
      throw notFound('Smart collection not found');
    }
    return row;
  }

  /**
   * Validate a rule tree against the live metadata field definitions and
   * compile it to SQL. Builtin field/operator legality is already enforced by
   * the shared schema and rule engine; this adds the checks that need DB state:
   * metadata slugs must exist and their operator must be legal for the field's
   * type. Also decides whether searchModels should apply its status default.
   */
  private async resolveAndCompile(definition: RuleNode): Promise<CompiledRules> {
    const conditions = collectConditions(definition);

    const metadataLeaves = conditions.filter(
      (c): c is typeof c & { field: { source: 'metadata'; slug: string } } =>
        c.field.source === 'metadata',
    );
    if (metadataLeaves.length > 0) {
      const fields = await metadataService.listFields();
      const bySlug = new Map(fields.map((f) => [f.slug, f]));
      for (const leaf of metadataLeaves) {
        const def = bySlug.get(leaf.field.slug);
        if (!def) {
          throw validationError(`Unknown metadata field: ${leaf.field.slug}`, 'definition');
        }
        const legal = LEGAL_OPERATORS_BY_METADATA_TYPE[def.type];
        if (!legal.includes(leaf.operator)) {
          throw validationError(
            `Operator '${leaf.operator}' is not valid for field '${leaf.field.slug}'`,
            'definition',
          );
        }
      }
    }

    const hasStatusLeaf = conditions.some(
      (c) => c.field.source === 'builtin' && c.field.field === 'status',
    );

    return { ruleWhere: compileRuleTree(definition), applyDefaultStatus: !hasStatusLeaf };
  }

  /** Count of models the tree currently matches (derived via searchModels). */
  private async countModels(compiled: CompiledRules, libraryId: string): Promise<number> {
    const result = await searchService.searchModels({ pageSize: 1 }, libraryId, compiled);
    return result.total;
  }

  private async toDetail(row: SmartCollectionRow, libraryId: string): Promise<SmartCollectionDetail> {
    const compiled = await this.resolveAndCompile(row.definition);
    const modelCount = await this.countModels(compiled, libraryId);
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      definition: row.definition,
      modelCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async create(
    data: CreateSmartCollectionRequest,
    userId: string,
    libraryId: string,
  ): Promise<SmartCollectionDetail> {
    // Validate the tree before insert so a bad definition is a 4xx, not a row.
    await this.resolveAndCompile(data.definition);

    const slug = generateSlug(data.name);
    const [row] = await db
      .insert(smartCollections)
      .values({
        name: data.name,
        slug,
        description: data.description ?? null,
        definition: data.definition,
        userId,
        libraryId,
      })
      .returning();

    logger.info(
      { service: 'SmartCollectionService', smartCollectionId: row.id, name: row.name, slug },
      'Smart collection created',
    );

    return this.toDetail(row, libraryId);
  }

  async getById(id: string, userId: string, libraryId: string): Promise<SmartCollectionDetail> {
    const row = await this.requireOwnedSmartCollection(id, userId, libraryId);
    return this.toDetail(row, libraryId);
  }

  /** List smart collections for a user+library (no result counts — kept cheap). */
  async list(userId: string, libraryId: string): Promise<SmartCollection[]> {
    const rows = await db
      .select()
      .from(smartCollections)
      .where(and(eq(smartCollections.userId, userId), eq(smartCollections.libraryId, libraryId)))
      .orderBy(smartCollections.createdAt);
    return rows.map(toEntity);
  }

  async update(
    id: string,
    data: UpdateSmartCollectionRequest,
    userId: string,
    libraryId: string,
  ): Promise<SmartCollectionDetail> {
    await this.requireOwnedSmartCollection(id, userId, libraryId);

    if (data.definition !== undefined) {
      await this.resolveAndCompile(data.definition);
    }

    const updateValues: Partial<{
      name: string;
      slug: string;
      description: string | null;
      definition: RuleNode;
      updatedAt: Date;
    }> = { updatedAt: new Date() };

    if (data.name !== undefined) {
      updateValues.name = data.name;
      updateValues.slug = generateSlug(data.name);
    }
    if (data.description !== undefined) {
      updateValues.description = data.description;
    }
    if (data.definition !== undefined) {
      updateValues.definition = data.definition;
    }

    const [updated] = await db
      .update(smartCollections)
      .set(updateValues)
      .where(eq(smartCollections.id, id))
      .returning();

    logger.info(
      { service: 'SmartCollectionService', smartCollectionId: id },
      'Smart collection updated',
    );

    return this.toDetail(updated, libraryId);
  }

  async delete(id: string, userId: string, libraryId: string): Promise<void> {
    await this.requireOwnedSmartCollection(id, userId, libraryId);
    await db.delete(smartCollections).where(eq(smartCollections.id, id));
    logger.info(
      { service: 'SmartCollectionService', smartCollectionId: id },
      'Smart collection deleted',
    );
  }

  /**
   * The derived result set for a saved smart collection. Ad-hoc params (extra
   * tags, sort, pagination) are ANDed onto the compiled rule tree by searchModels.
   */
  async getModels(
    id: string,
    params: ModelSearchParams,
    userId: string,
    libraryId: string,
  ): Promise<SearchResult> {
    const row = await this.requireOwnedSmartCollection(id, userId, libraryId);
    const compiled = await this.resolveAndCompile(row.definition);
    return searchService.searchModels(params, libraryId, compiled);
  }

  /** Dry-run an unsaved rule tree — used by the composer's live preview. */
  async preview(
    definition: RuleNode,
    params: ModelSearchParams,
    libraryId: string,
  ): Promise<SearchResult> {
    const compiled = await this.resolveAndCompile(definition);
    return searchService.searchModels(params, libraryId, compiled);
  }
}

export const smartCollectionService = new SmartCollectionService();
