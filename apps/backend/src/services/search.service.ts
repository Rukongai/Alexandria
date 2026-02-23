import { and, asc, desc, sql, SQL } from 'drizzle-orm';
import type {
  ModelSearchParams,
  ModelCard,
} from '@alexandria/shared';
import { db } from '../db/index.js';
import { models } from '../db/schema/index.js';
import { presenterService } from './presenter.service.js';
import { validationError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SearchService');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ISearchService {
  searchModels(params: ModelSearchParams): Promise<SearchResult>;
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
 * Convert a user-supplied search string into a Postgres tsquery expression.
 * Example: "dragon bust" → "dragon & bust:*"
 * Prefix matching is applied only to the last token so mid-string words still
 * require exact form, keeping result quality reasonable.
 */
function buildTsQuery(q: string): string {
  const tokens = q.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';

  // Escape characters that have special meaning in tsquery
  const safe = tokens.map((t) => t.replace(/[!'()*:&|<>]/g, ''));
  const filtered = safe.filter(Boolean);
  if (filtered.length === 0) return '';

  const last = filtered.length - 1;
  const parts = filtered.map((t, i) => (i === last ? `${t}:*` : t));
  return parts.join(' & ');
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
  async searchModels(params: ModelSearchParams): Promise<SearchResult> {
    const pageSize = Math.min(params.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const sortField = params.sort ?? 'createdAt';
    const sortDir = params.sortDir ?? 'desc';
    const useRelevanceSort = !!params.q && !params.sort;

    logger.debug(
      {
        service: 'SearchService',
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

    // Status filter
    if (params.status) {
      conditions.push(sql`${models.status} = ${params.status}`);
    }

    // File type filter — EXISTS subquery
    if (params.fileType) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM model_files mf
          WHERE mf.model_id = ${models.id}
            AND mf.file_type = ${params.fileType}
        )`,
      );
    }

    // Collection filter
    if (params.collectionId) {
      conditions.push(
        sql`${models.id} IN (
          SELECT cm.model_id FROM collection_models cm
          WHERE cm.collection_id = ${params.collectionId}
        )`,
      );
    }

    // Tags filter — ALL semantics (model must have every listed tag)
    if (params.tags) {
      const tagSlugs = params.tags.split(',').map((s) => s.trim()).filter(Boolean);
      if (tagSlugs.length > 0) {
        for (const slug of tagSlugs) {
          conditions.push(
            sql`${models.id} IN (
              SELECT mt.model_id FROM model_tags mt
              INNER JOIN tags t ON t.id = mt.tag_id
              WHERE t.slug = ${slug}
            )`,
          );
        }
      }
    }

    // Generic metadata filters
    if (params.metadataFilters && Object.keys(params.metadataFilters).length > 0) {
      for (const [fieldSlug, value] of Object.entries(params.metadataFilters)) {
        conditions.push(
          sql`${models.id} IN (
            SELECT mm.model_id FROM model_metadata mm
            INNER JOIN metadata_field_definitions fd ON fd.id = mm.field_definition_id
            WHERE fd.slug = ${fieldSlug}
              AND mm.value = ${value}
          )`,
        );
      }
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
        fileCount: models.fileCount,
        totalSizeBytes: models.totalSizeBytes,
        createdAt: models.createdAt,
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
}

export const searchService = new PostgresSearchService();
