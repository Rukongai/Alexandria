import { eq, and, inArray, asc, desc, sql, SQL } from 'drizzle-orm';
import type {
  ModelSearchParams,
  ModelCard,
  MetadataValue,
  MetadataFieldType,
  FileType,
  ModelStatus,
} from '@alexandria/shared';
import { db } from '../db/index.js';
import {
  models,
  modelFiles,
  tags,
  modelTags,
  modelMetadata,
  metadataFieldDefinitions,
  collectionModels,
  thumbnails,
} from '../db/schema/index.js';
import type { Model as ModelRow } from '../db/schema/model.js';
import { validationError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SearchService');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const GRID_THUMBNAIL_WIDTH = 400;

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

/**
 * Format a display value for a metadata type. Mirrors the helper in MetadataService
 * but lives here to keep SearchService self-contained (no cross-service calls).
 */
function formatDisplayValue(type: MetadataFieldType, value: string | string[]): string {
  if (type === 'boolean') {
    return value === 'true' ? 'Yes' : 'No';
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return value;
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

    // We need a plain SQL expression for the sort column so we can reference it
    // in cursor comparisons and ORDER BY clauses.
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

    // Build ORDER BY: primary sort column, secondary tiebreaker by id
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
    // Batch-load thumbnails for all returned models
    // Thumbnail URL: first image file per model → its grid-size thumbnail
    // -----------------------------------------------------------------------

    // Step 1: find the first image file per model (smallest id as tiebreaker)
    const imageFileRows = await db
      .select({
        modelId: modelFiles.modelId,
        fileId: modelFiles.id,
      })
      .from(modelFiles)
      .where(
        and(
          inArray(modelFiles.modelId, modelIds),
          eq(modelFiles.fileType, 'image' as FileType),
        ),
      )
      .orderBy(asc(modelFiles.createdAt));

    // Keep only one image file per model (the first one encountered)
    const firstImageFileByModel = new Map<string, string>();
    for (const row of imageFileRows) {
      if (!firstImageFileByModel.has(row.modelId)) {
        firstImageFileByModel.set(row.modelId, row.fileId);
      }
    }

    const imageFileIds = [...firstImageFileByModel.values()];

    // Step 2: find the grid-size thumbnail for each image file
    const thumbnailRows =
      imageFileIds.length > 0
        ? await db
            .select({
              id: thumbnails.id,
              sourceFileId: thumbnails.sourceFileId,
            })
            .from(thumbnails)
            .where(
              and(
                inArray(thumbnails.sourceFileId, imageFileIds),
                eq(thumbnails.width, GRID_THUMBNAIL_WIDTH),
              ),
            )
        : [];

    // Map sourceFileId → thumbnailId
    const thumbnailByFileId = new Map<string, string>();
    for (const t of thumbnailRows) {
      thumbnailByFileId.set(t.sourceFileId, t.id);
    }

    // Resolve final thumbnailUrl per modelId
    const thumbnailUrlByModel = new Map<string, string>();
    for (const [modelId, fileId] of firstImageFileByModel.entries()) {
      const thumbId = thumbnailByFileId.get(fileId);
      if (thumbId) {
        thumbnailUrlByModel.set(modelId, `/files/thumbnails/${thumbId}.webp`);
      }
    }

    // -----------------------------------------------------------------------
    // Batch-load metadata for all returned models
    // -----------------------------------------------------------------------

    // Generic metadata (model_metadata + field definitions)
    const genericMetaRows = await db
      .select({
        modelId: modelMetadata.modelId,
        fieldSlug: metadataFieldDefinitions.slug,
        fieldName: metadataFieldDefinitions.name,
        fieldType: metadataFieldDefinitions.type,
        value: modelMetadata.value,
      })
      .from(modelMetadata)
      .innerJoin(
        metadataFieldDefinitions,
        eq(modelMetadata.fieldDefinitionId, metadataFieldDefinitions.id),
      )
      .where(inArray(modelMetadata.modelId, modelIds));

    // Tag metadata (model_tags + tags)
    const tagMetaRows = await db
      .select({
        modelId: modelTags.modelId,
        tagName: tags.name,
      })
      .from(modelTags)
      .innerJoin(tags, eq(modelTags.tagId, tags.id))
      .where(inArray(modelTags.modelId, modelIds));

    // Group generic metadata by modelId
    const genericMetaByModel = new Map<string, MetadataValue[]>();
    for (const row of genericMetaRows) {
      if (!genericMetaByModel.has(row.modelId)) {
        genericMetaByModel.set(row.modelId, []);
      }
      const type = row.fieldType as MetadataFieldType;
      genericMetaByModel.get(row.modelId)!.push({
        fieldSlug: row.fieldSlug,
        fieldName: row.fieldName,
        type,
        value: row.value,
        displayValue: formatDisplayValue(type, row.value),
      });
    }

    // Group tags by modelId
    const tagsByModel = new Map<string, string[]>();
    for (const row of tagMetaRows) {
      if (!tagsByModel.has(row.modelId)) {
        tagsByModel.set(row.modelId, []);
      }
      tagsByModel.get(row.modelId)!.push(row.tagName);
    }

    // -----------------------------------------------------------------------
    // Assemble ModelCard results
    // -----------------------------------------------------------------------

    const modelCards: ModelCard[] = rows.map((row) => {
      const metadata: MetadataValue[] = genericMetaByModel.get(row.id) ?? [];
      const tagNames = tagsByModel.get(row.id);
      if (tagNames && tagNames.length > 0) {
        metadata.push({
          fieldSlug: 'tags',
          fieldName: 'Tags',
          type: 'multi_enum',
          value: tagNames,
          displayValue: formatDisplayValue('multi_enum', tagNames),
        });
      }

      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status as ModelStatus,
        fileCount: row.fileCount,
        totalSizeBytes: row.totalSizeBytes,
        createdAt: row.createdAt.toISOString(),
        thumbnailUrl: thumbnailUrlByModel.get(row.id) ?? null,
        metadata,
      };
    });

    // -----------------------------------------------------------------------
    // Compute next cursor from the last row
    // -----------------------------------------------------------------------

    let nextCursor: string | null = null;
    if (rows.length === pageSize) {
      const lastRow = rows[rows.length - 1];
      // sortValue is the value of the sort column for the last row
      const rawSortValue = lastRow.sortValue;
      // Normalize to a serializable primitive
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
