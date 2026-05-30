/**
 * Global (cross-entity) search types.
 *
 * One query fans out across every type Alexandria indexes — models, collections,
 * artists, and tags — and the results are grouped by type for the search page.
 */

import type { ModelCard } from './model.js';

/**
 * Parameters for a global search request.
 */
export interface GlobalSearchParams {
  q: string;
  /** Max hits returned per result type (default applied server-side). */
  limit?: number;
}

/**
 * A collection that matched the query.
 */
export interface SearchCollectionHit {
  id: string;
  name: string;
  slug: string;
  modelCount: number;
}

/**
 * An artist (a metadata value) that matched the query.
 */
export interface SearchArtistHit {
  name: string;
  modelCount: number;
}

/**
 * A tag that matched the query.
 */
export interface SearchTagHit {
  name: string;
  modelCount: number;
}

/**
 * Aggregated cross-entity search result.
 *
 * Each result type is scored/sorted independently — there is no unified
 * relevance score across types (models use full-text rank, the rest are ordered
 * by usage count).
 */
export interface GlobalSearchResult {
  q: string;
  models: {
    items: ModelCard[];
    /** Total matching models, ignoring the per-type limit. */
    total: number;
  };
  collections: SearchCollectionHit[];
  artists: SearchArtistHit[];
  tags: SearchTagHit[];
}
