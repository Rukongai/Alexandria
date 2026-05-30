import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ModelSearchParams } from '@alexandria/shared';

export interface ModelFilters {
  q: string;
  tags: string[];
  sort: ModelSearchParams['sort'];
  sortDir: ModelSearchParams['sortDir'];
  status: ModelSearchParams['status'];
  collectionId: string | undefined;
  metadataFilters: Record<string, string>;
}

export type PivotAxis = 'collections' | 'artists' | 'tags';

const VALID_AXES: PivotAxis[] = ['collections', 'artists', 'tags'];
const DEFAULT_AXIS: PivotAxis = 'collections';

/**
 * The currently-selected value for the active pivot axis:
 * - axis 'collections': collectionId (string | undefined)
 * - axis 'artists': the value of metadataFilters['artist'] (string | undefined)
 * - axis 'tags': the selected tag names (string[])
 */
export interface ActiveAxisValue {
  collectionId: string | undefined;
  artist: string | undefined;
  tags: string[];
}

function parseMetaFilters(params: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (key.startsWith('meta_')) {
      const slug = key.slice(5);
      result[slug] = value;
    }
  }
  return result;
}

export function useModelFilters() {
  const [searchParams, setSearchParams] = useSearchParams();

  const filters: ModelFilters = {
    q: searchParams.get('q') ?? '',
    tags: searchParams.get('tags') ? searchParams.get('tags')!.split(',').filter(Boolean) : [],
    sort: (searchParams.get('sort') as ModelSearchParams['sort']) ?? undefined,
    sortDir: (searchParams.get('sortDir') as ModelSearchParams['sortDir']) ?? undefined,
    status: (searchParams.get('status') as ModelSearchParams['status']) ?? undefined,
    collectionId: searchParams.get('collectionId') ?? undefined,
    metadataFilters: parseMetaFilters(searchParams),
  };

  // axis is pure UI — NOT in ModelFilters, NOT in toApiParams, NOT in the query key
  const rawAxis = searchParams.get('axis');
  const axis: PivotAxis =
    rawAxis !== null && VALID_AXES.includes(rawAxis as PivotAxis)
      ? (rawAxis as PivotAxis)
      : DEFAULT_AXIS;

  // activeAxisValue reflects what is selected for the current axis
  const activeAxisValue: ActiveAxisValue = {
    collectionId: axis === 'collections' ? filters.collectionId : undefined,
    artist: axis === 'artists' ? filters.metadataFilters['artist'] : undefined,
    tags: axis === 'tags' ? filters.tags : [],
  };

  const toApiParams = useCallback(
    (cursor?: string): ModelSearchParams => {
      const params: ModelSearchParams = {};
      if (filters.q) params.q = filters.q;
      if (filters.tags.length > 0) params.tags = filters.tags.join(',');
      if (filters.sort) params.sort = filters.sort;
      if (filters.sortDir) params.sortDir = filters.sortDir;
      if (filters.status) params.status = filters.status;
      if (filters.collectionId) params.collectionId = filters.collectionId;
      if (Object.keys(filters.metadataFilters).length > 0) {
        params.metadataFilters = filters.metadataFilters;
      }
      if (cursor) params.cursor = cursor;
      return params;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchParams]
  );

  const setFilter = useCallback(
    (key: string, value: string | undefined) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (value) {
          next.set(key, value);
        } else {
          next.delete(key);
        }
        return next;
      });
    },
    [setSearchParams]
  );

  const setQ = useCallback(
    (q: string) => setFilter('q', q || undefined),
    [setFilter]
  );

  const setSort = useCallback(
    (sort: ModelSearchParams['sort'], sortDir: ModelSearchParams['sortDir']) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (sort) {
          next.set('sort', sort);
        } else {
          next.delete('sort');
        }
        if (sortDir) {
          next.set('sortDir', sortDir);
        } else {
          next.delete('sortDir');
        }
        return next;
      });
    },
    [setSearchParams]
  );

  const setTags = useCallback(
    (tags: string[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (tags.length > 0) {
          next.set('tags', tags.join(','));
        } else {
          next.delete('tags');
        }
        return next;
      });
    },
    [setSearchParams]
  );

  const toggleTag = useCallback(
    (slug: string) => {
      const current = filters.tags;
      if (current.includes(slug)) {
        setTags(current.filter((t) => t !== slug));
      } else {
        setTags([...current, slug]);
      }
    },
    [filters.tags, setTags]
  );

  const setMetaFilter = useCallback(
    (slug: string, value: string | undefined) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (value) {
          next.set(`meta_${slug}`, value);
        } else {
          next.delete(`meta_${slug}`);
        }
        return next;
      });
    },
    [setSearchParams]
  );

  const clearMetaFilter = useCallback(
    (slug: string) => setMetaFilter(slug, undefined),
    [setMetaFilter]
  );

  const setCollectionId = useCallback(
    (id: string | undefined) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (id) {
          next.set('collectionId', id);
        } else {
          next.delete('collectionId');
        }
        return next;
      });
    },
    [setSearchParams]
  );

  const clearAllFilters = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams();
      // Preserve the axis param so clearing filters doesn't reset the user's chosen axis
      const currentAxis = prev.get('axis');
      if (currentAxis) next.set('axis', currentAxis);
      return next;
    });
  }, [setSearchParams]);

  const hasActiveFilters =
    filters.q.length > 0 ||
    filters.tags.length > 0 ||
    filters.status !== undefined ||
    filters.collectionId !== undefined ||
    Object.keys(filters.metadataFilters).length > 0;

  // setAxis writes ?axis= to the URL while preserving all other params.
  // The default axis ('collections') is omitted from the URL for cleaner links.
  const setAxis = useCallback(
    (a: PivotAxis) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (a === DEFAULT_AXIS) {
          next.delete('axis');
        } else {
          next.set('axis', a);
        }
        return next;
      });
    },
    [setSearchParams]
  );

  return {
    filters,
    toApiParams,
    setQ,
    setSort,
    setTags,
    toggleTag,
    setCollectionId,
    setMetaFilter,
    clearMetaFilter,
    clearAllFilters,
    hasActiveFilters,
    // Pivot UI state — separate from filters and the query key
    axis,
    setAxis,
    activeAxisValue,
  };
}
