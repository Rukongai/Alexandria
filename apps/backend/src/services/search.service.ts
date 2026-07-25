import { and, asc, desc, eq, sql, SQL } from 'drizzle-orm';
import type {
  ModelSearchParams,
  ModelCard,
  GlobalSearchParams,
  GlobalSearchResult,
} from '@alexandria/shared';
import { db } from '../db/index.js';
import { models } from '../db/schema/index.js';
import { presenterService } from './presenter.service.js';
import { collectionService } from './collection.service.js';
import { metadataService } from './metadata.service.js';
import { buildLeafCondition, buildTsQuery } from './rule-engine.js';
import type { RuleCondition, RuleFieldRef, RuleOperator } from '@alexandria/shared';
import { validationError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SearchService');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const DEFAULT_GLOBAL_LIMIT = 6;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * Extra options for searchModels. `ruleWhere` is a pre-compiled smart-collection
 * rule tree (see rule-engine) ANDed into the query. `applyDefaultStatus`
 * controls the implicit status='ready' default — smart collections suppress it
 * when their rule tree references status, to avoid a contradiction.
 */
export interface SearchModelsOptions {
  ruleWhere?: SQL;
  applyDefaultStatus?: boolean;
}

export interface ISearchService {
  searchModels(
    params: ModelSearchParams,
    libraryId: string,
    options?: SearchModelsOptions,
  ): Promise<SearchResult>;
  searchAll(
    params: GlobalSearchParams,
    userId: string,
    libraryId: string,
  ): Promise<GlobalSearchResult>;
}

export interface SearchResult {
  models: ModelCard[];
  total: number;
  cursor: string | null;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Internal cursor type
// ---------------------------------------------------------------------------

interface CursorPayload {
  v: string | number;
  id: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a single flat filter as a rule-engine leaf, so flat search and smart
 * collections emit identical SQL per dimension (buildTsQuery is shared too).
 */
function leaf(field: RuleFieldRef, operator: RuleOperator, value: string) {
  const condition: RuleCondition = { kind: 'condition', field, operator, value };
  return buildLeafCondition(condition);
}

function encodeCursor(sortValue: string | number, id: string): string {
  const payload: CursorPayload = { v: sortValue, id };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf-8');
    return JSON.parse(raw) as CursorPayload;
  } catch {
    throw validationError('Invalid pagination cursor');
  }
}

/**
 * Build a WHERE fragment that implements cursor-based keyset pagination.
 *
 * For descending sorts: next page is where (col < v) OR (col = v AND id < cursorId)
 * For ascending sorts:  next page is where (col > v) OR (col = v AND id > cursorId)
 *
 * We use raw SQL here because Drizzle does not natively express OR between two
 * compound conditions with a mix of typed column references and literal values.
 */
function buildCursorWhere(
  sortColumn: SQL,
  cursorId: string,
  cursorValue: string | number,
  direction: 'asc' | 'desc',
): SQL {
  if (direction === 'desc') {
    return sql`(${sortColumn} < ${cursorValue} OR (${sortColumn} = ${cursorValue} AND ${models.id} < ${cursorId}))`;
  }
  return sql`(${sortColumn} > ${cursorValue} OR (${sortColumn} = ${cursorValue} AND ${models.id} > ${cursorId}))`;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class PostgresSearchService implements ISearchService {
  async searchModels(
    params: ModelSearchParams,
    libraryId: string,
    options: SearchModelsOptions = {},
  ): Promise<SearchResult> {
    const { ruleWhere, applyDefaultStatus = true } = options;
    const pageSize = Math.min(params.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const sortField = params.sort ?? 'createdAt';
    const sortDir = params.sortDir ?? 'desc';
    const useRelevanceSort = !!params.q && !params.sort;

    logger.debug(
      {
        service: 'SearchService',
        libraryId,
        q: params.q,
        tags: params.tags,
        collectionId: params.collectionId,
        fileType: params.fileType,
        status: params.status,
        sort: sortField,
        sortDir,
        pageSize,
        hasCursor: !!params.cursor,
      },
      'Executing model search',
    );

    // -----------------------------------------------------------------------
    // Build the shared WHERE conditions
    // -----------------------------------------------------------------------

    const conditions: SQL[] = [];

    // Library scope — always enforced; server-injected, never from query params
    conditions.push(eq(models.libraryId, libraryId));

    // Full-text search
    let tsQuery: string | null = null;
    if (params.q) {
      tsQuery = buildTsQuery(params.q);
      if (tsQuery) {
        conditions.push(
          sql`${models.searchVector} @@ to_tsquery('english', ${tsQuery})`,
        );
      }
    }

    // Status filter — default to 'ready' to exclude processing/error models.
    // The default is suppressed when a smart-collection rule tree already
    // constrains status (applyDefaultStatus=false), to avoid a contradiction.
    if (params.status) {
      conditions.push(leaf({ source: 'builtin', field: 'status' }, 'is', params.status));
    } else if (applyDefaultStatus) {
      conditions.push(leaf({ source: 'builtin', field: 'status' }, 'is', 'ready'));
    }

    // File type filter — EXISTS subquery
    if (params.fileType) {
      conditions.push(leaf({ source: 'builtin', field: 'fileType' }, 'has', params.fileType));
    }

    // Collection filter
    if (params.collectionId) {
      conditions.push(
        leaf({ source: 'builtin', field: 'collection' }, 'inCollection', params.collectionId),
      );
    }

    // Tags filter — ALL semantics (model must have every listed tag).
    // Matches by tag name (case-insensitive); one membership leaf per tag.
    if (params.tags) {
      const tagNames = params.tags.split(',').map((s) => s.trim()).filter(Boolean);
      for (const name of tagNames) {
        conditions.push(leaf({ source: 'builtin', field: 'tag' }, 'hasTag', name));
      }
    }

    // Generic metadata filters — exact value match per field slug
    if (params.metadataFilters && Object.keys(params.metadataFilters).length > 0) {
      for (const [fieldSlug, value] of Object.entries(params.metadataFilters)) {
        conditions.push(leaf({ source: 'metadata', slug: fieldSlug }, 'equals', value));
      }
    }

    // Smart-collection rule tree (pre-compiled by the caller), ANDed in.
    if (ruleWhere) {
      conditions.push(ruleWhere);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // -----------------------------------------------------------------------
    // Determine sort column expression
    // -----------------------------------------------------------------------

    let sortColumnSql: SQL;
    if (useRelevanceSort && tsQuery) {
      sortColumnSql = sql`ts_rank_cd(${models.searchVector}, to_tsquery('english', ${tsQuery}))`;
    } else if (sortField === 'name') {
      sortColumnSql = sql`${models.name}`;
    } else if (sortField === 'totalSizeBytes') {
      sortColumnSql = sql`${models.totalSizeBytes}`;
    } else {
      // default: createdAt
      sortColumnSql = sql`${models.createdAt}`;
    }

    // -----------------------------------------------------------------------
    // Count query (no pagination, no ORDER BY)
    // -----------------------------------------------------------------------

    const [countRow] = await db
      .select({ total: sql<number>`cast(count(*) as int)` })
      .from(models)
      .where(whereClause);

    const total = countRow?.total ?? 0;

    // -----------------------------------------------------------------------
    // Cursor pagination condition
    // -----------------------------------------------------------------------

    let cursorCondition: SQL | undefined;
    if (params.cursor) {
      const { v: cursorValue, id: cursorId } = decodeCursor(params.cursor);
      cursorCondition = buildCursorWhere(sortColumnSql, cursorId, cursorValue, sortDir);
    }

    const finalWhere =
      whereClause && cursorCondition
        ? and(whereClause, cursorCondition)
        : whereClause ?? cursorCondition;

    // -----------------------------------------------------------------------
    // Main SELECT query
    // -----------------------------------------------------------------------

    const orderByExpression =
      sortDir === 'desc'
        ? [desc(sortColumnSql), desc(models.id)]
        : [asc(sortColumnSql), asc(models.id)];

    const rows = await db
      .select({
        id: models.id,
        name: models.name,
        slug: models.slug,
        status: models.status,
        isDuplicate: models.isDuplicate,
        fileCount: models.fileCount,
        totalSizeBytes: models.totalSizeBytes,
        createdAt: models.createdAt,
        previewImageFileId: models.previewImageFileId,
        previewCropX: models.previewCropX,
        previewCropY: models.previewCropY,
        previewCropScale: models.previewCropScale,
        // Include the sort value in the result so we can encode the cursor
        sortValue: sortColumnSql,
      })
      .from(models)
      .where(finalWhere)
      .orderBy(...orderByExpression)
      .limit(pageSize);

    if (rows.length === 0) {
      return { models: [], total, cursor: null, pageSize };
    }

    const modelIds = rows.map((r) => r.id);

    // -----------------------------------------------------------------------
    // Delegate card assembly to PresenterService
    // -----------------------------------------------------------------------

    const modelCards = await presenterService.buildModelCardsFromRows(rows, modelIds);

    // -----------------------------------------------------------------------
    // Compute next cursor from the last row
    // -----------------------------------------------------------------------

    let nextCursor: string | null = null;
    if (rows.length === pageSize) {
      const lastRow = rows[rows.length - 1];
      const rawSortValue = lastRow.sortValue;
      const sortValue =
        rawSortValue instanceof Date
          ? rawSortValue.toISOString()
          : (rawSortValue as string | number);
      nextCursor = encodeCursor(sortValue, lastRow.id);
    }

    logger.info(
      {
        service: 'SearchService',
        total,
        returned: rows.length,
        pageSize,
        hasNextPage: nextCursor !== null,
      },
      'Model search complete',
    );

    return {
      models: modelCards,
      total,
      cursor: nextCursor,
      pageSize,
    };
  }

  /**
   * Cross-entity search: models (full-text), plus collections, artists, and
   * tags matched by name. Each type is scored/sorted independently — models by
   * full-text relevance, the rest by usage count. Library-scoped throughout.
   */
  async searchAll(
    params: GlobalSearchParams,
    userId: string,
    libraryId: string,
  ): Promise<GlobalSearchResult> {
    const limit = params.limit ?? DEFAULT_GLOBAL_LIMIT;
    const q = params.q.trim();
    const needle = q.toLowerCase();

    const modelResult = await this.searchModels({ q, pageSize: limit }, libraryId);

    return {
      q,
      models: { items: modelResult.models, total: modelResult.total },
      collections: await this.searchCollections(needle, userId, libraryId, limit),
      artists: await this.searchArtists(needle, libraryId, limit),
      tags: await this.searchTags(needle, libraryId, limit),
    };
  }

  private async searchCollections(
    needle: string,
    userId: string,
    libraryId: string,
    limit: number,
  ): Promise<GlobalSearchResult['collections']> {
    // Collections have no tsvector; match by name. The set is small, so we
    // filter in memory rather than maintaining a separate index.
    const collections = await collectionService.listCollections(userId, libraryId).catch(() => []);
    return collections
      .filter((c) => c.name.toLowerCase().includes(needle))
      .sort((a, b) => b.modelCount - a.modelCount)
      .slice(0, limit)
      .map((c) => ({ id: c.id, name: c.name, slug: c.slug, modelCount: c.modelCount }));
  }

  private async searchArtists(
    needle: string,
    libraryId: string,
    limit: number,
  ): Promise<GlobalSearchResult['artists']> {
    const values = await metadataService.listFieldValues('artist', libraryId).catch(() => []);
    return values
      .filter((v) => v.value.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((v) => ({ name: v.value, modelCount: v.modelCount }));
  }

  private async searchTags(
    needle: string,
    libraryId: string,
    limit: number,
  ): Promise<GlobalSearchResult['tags']> {
    const values = await metadataService.listFieldValues('tags', libraryId).catch(() => []);
    return values
      .filter((v) => v.value.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((v) => ({ name: v.value, modelCount: v.modelCount }));
  }
}

export const searchService = new PostgresSearchService();
