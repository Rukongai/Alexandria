import { useCallback, useEffect, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { ApiResponse, ModelCard, ModelSearchParams } from '@alexandria/shared';
import { getModels } from '../api/models';
import type { ModelFilters } from './use-model-filters';

export interface UseModelResultsInput {
  filters: ModelFilters;
  toApiParams: (cursor?: string) => ModelSearchParams;
  /** Override the fetch source (e.g. a smart collection's derived models). */
  fetcher?: (params: ModelSearchParams) => Promise<ApiResponse<ModelCard[]>>;
  /** Extra query-key segments distinguishing this fetch source from the default. */
  queryKeyExtra?: unknown[];
  /** When false, the query does not run (e.g. smart axis with nothing selected). */
  enabled?: boolean;
}

export interface UseModelResultsOutput {
  models: ModelCard[];
  total: number;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Data engine for model browsing: infinite-scroll query + IntersectionObserver
 * sentinel. Shared by the grid view and future pivot views so all views use
 * identical fetching/paging behavior.
 *
 * Bulk selection is intentionally NOT here — it is UI-only state that lives
 * in the consuming component.
 */
export function useModelResults({
  filters,
  toApiParams,
  fetcher = getModels,
  queryKeyExtra = [],
  enabled = true,
}: UseModelResultsInput): UseModelResultsOutput {
  const sentinelRef = useRef<HTMLDivElement>(null);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
  } = useInfiniteQuery({
    queryKey: ['models', ...queryKeyExtra, filters],
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const params: ModelSearchParams = toApiParams(pageParam);
      return fetcher(params);
    },
    getNextPageParam: (lastPage) => lastPage.meta?.cursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    staleTime: 30_000,
    enabled,
  });

  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage]
  );

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(handleIntersect, {
      rootMargin: '200px',
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [handleIntersect]);

  const models: ModelCard[] = data?.pages.flatMap((page) => page.data) ?? [];
  const total = data?.pages[0]?.meta?.total ?? 0;

  return {
    models,
    total,
    isLoading,
    isError,
    error: error as Error | null,
    isFetchingNextPage,
    hasNextPage: hasNextPage ?? false,
    fetchNextPage,
    sentinelRef,
  };
}
