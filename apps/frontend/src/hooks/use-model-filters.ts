import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { ModelSearchParams } from '@alexandria/shared';
import { useLibraryPath } from './use-libraries';

export interface ModelFilters {
  q: string;
  tags: string[];
  sort: ModelSearchParams['sort'];
  sortDir: ModelSearchParams['sortDir'];
  status: ModelSearchParams['status'];
  collectionId: string | undefined;
  metadataFilters: Record<string, string>;
}

export type BuiltInPivotAxis = 'collections' | 'artists' | 'tags' | 'smart';
export type MetadataPivotAxis = `metadata:${string}`;
export type PivotAxis = BuiltInPivotAxis | MetadataPivotAxis;

const VALID_AXES: BuiltInPivotAxis[] = ['collections', 'artists', 'tags', 'smart'];
const DEFAULT_AXIS: BuiltInPivotAxis = 'collections';
const RESERVED_METADATA_AXIS_SLUGS = new Set(['artist', 'tags']);

export function isValidMetadataAxisSlug(slug: string): boolean {
  return slug.length > 0
    && slug.length <= 255
    && !RESERVED_METADATA_AXIS_SLUGS.has(slug);
}

export function getMetadataAxisSlug(axis: PivotAxis): string | undefined {
  if (!axis.startsWith('metadata:')) return undefined;
  const slug = axis.slice('metadata:'.length);
  return isValidMetadataAxisSlug(slug) ? slug : undefined;
}

function parsePivotAxis(rawAxis: string | null): PivotAxis {
  if (rawAxis && VALID_AXES.includes(rawAxis as BuiltInPivotAxis)) {
    return rawAxis as BuiltInPivotAxis;
  }
  if (rawAxis?.startsWith('metadata:') && getMetadataAxisSlug(rawAxis as MetadataPivotAxis)) {
    return rawAxis as MetadataPivotAxis;
  }
  return DEFAULT_AXIS;
}

/**
 * The currently-selected value for the active pivot axis:
 * - axis 'collections': collectionId (string | undefined)
 * - axis 'artists': the value of metadataFilters['artist'] (string | undefined)
 * - axis 'tags': the selected tag names (string[])
 * - axis 'smart': smartCollectionId (string | undefined)
 */
export interface ActiveAxisValue {
  collectionId: string | undefined;
  artist: string | undefined;
  tags: string[];
  smartCollectionId: string | undefined;
  metadata?: { slug: string; value: string | undefined };
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
  const location = useLocation();
  const navigate = useNavigate();
  const libPath = useLibraryPath();
  const browsePath = libPath('/');

  const updateSearchParams = useCallback(
    (update: (params: URLSearchParams) => URLSearchParams | void) => {
      if (location.pathname === browsePath) {
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          return update(next) ?? next;
        });
        return;
      }

      const next = new URLSearchParams(searchParams);
      const updated = update(next) ?? next;
      const query = updated.toString();
      navigate({ pathname: browsePath, search: query ? `?${query}` : '' });
    },
    [browsePath, location.pathname, navigate, searchParams, setSearchParams]
  );

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
  const axis = parsePivotAxis(searchParams.get('axis'));
  const metadataAxisSlug = getMetadataAxisSlug(axis);

  // smartCollectionId is pure UI selection (which smart collection to view) —
  // like axis, it is NOT a model filter and not in toApiParams/the query key.
  const smartCollectionId = searchParams.get('smartCollectionId') ?? undefined;

  // activeAxisValue reflects what is selected for the current axis
  const activeAxisValue: ActiveAxisValue = {
    collectionId: axis === 'collections' ? filters.collectionId : undefined,
    artist: axis === 'artists' ? filters.metadataFilters['artist'] : undefined,
    tags: axis === 'tags' ? filters.tags : [],
    smartCollectionId: axis === 'smart' ? smartCollectionId : undefined,
    metadata: metadataAxisSlug
      ? { slug: metadataAxisSlug, value: filters.metadataFilters[metadataAxisSlug] }
      : undefined,
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
      updateSearchParams((next) => {
        if (value) {
          next.set(key, value);
        } else {
          next.delete(key);
        }
      });
    },
    [updateSearchParams]
  );

  const setQ = useCallback(
    (q: string) => setFilter('q', q || undefined),
    [setFilter]
  );

  const setSort = useCallback(
    (sort: ModelSearchParams['sort'], sortDir: ModelSearchParams['sortDir']) => {
      updateSearchParams((next) => {
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
      });
    },
    [updateSearchParams]
  );

  const setTags = useCallback(
    (tags: string[]) => {
      updateSearchParams((next) => {
        if (tags.length > 0) {
          next.set('tags', tags.join(','));
        } else {
          next.delete('tags');
        }
      });
    },
    [updateSearchParams]
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
      updateSearchParams((next) => {
        if (value) {
          next.set(`meta_${slug}`, value);
        } else {
          next.delete(`meta_${slug}`);
        }
      });
    },
    [updateSearchParams]
  );

  const clearMetaFilter = useCallback(
    (slug: string) => setMetaFilter(slug, undefined),
    [setMetaFilter]
  );

  const setCollectionId = useCallback(
    (id: string | undefined) => {
      updateSearchParams((next) => {
        if (id) {
          next.set('collectionId', id);
        } else {
          next.delete('collectionId');
        }
      });
    },
    [updateSearchParams]
  );

  const clearAllFilters = useCallback(() => {
    updateSearchParams((next) => {
      // Preserve the axis param so clearing filters doesn't reset the user's chosen axis
      const currentAxis = next.get('axis');
      const cleared = new URLSearchParams();
      if (currentAxis) {
        cleared.set('axis', currentAxis);
      }
      return cleared;
    });
  }, [updateSearchParams]);

  const hasActiveFilters =
    filters.q.length > 0 ||
    filters.tags.length > 0 ||
    filters.status !== undefined ||
    filters.collectionId !== undefined ||
    Object.keys(filters.metadataFilters).length > 0;

  const setSmartCollectionId = useCallback(
    (id: string | undefined) => {
      updateSearchParams((next) => {
        if (id) {
          next.set('smartCollectionId', id);
        } else {
          next.delete('smartCollectionId');
        }
      });
    },
    [updateSearchParams]
  );

  // setAxis writes ?axis= to the URL while preserving all other params.
  // The default axis ('collections') is omitted from the URL for cleaner links.
  const setAxis = useCallback(
    (a: PivotAxis) => {
      updateSearchParams((next) => {
        if (a === DEFAULT_AXIS) {
          next.delete('axis');
        } else {
          next.set('axis', a);
        }
      });
    },
    [updateSearchParams]
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
    smartCollectionId,
    setSmartCollectionId,
  };
}
