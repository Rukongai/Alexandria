import { useEffect, useRef, useCallback, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { CheckSquare, Square } from 'lucide-react';
import type { ModelCard, ModelSearchParams } from '@alexandria/shared';
import { getModels } from '../api/models';
import { useModelFilters } from '../hooks/use-model-filters';
import { useBulkSelection } from '../hooks/use-bulk-selection';
import { ModelCard as ModelCardComponent } from '../components/models/ModelCard';
import { ModelCardSkeleton } from '../components/models/ModelCardSkeleton';
import { SearchBar } from '../components/models/SearchBar';
import { SortControls } from '../components/models/SortControls';
import { FilterPanel } from '../components/models/FilterPanel';
import { ActiveFilters } from '../components/models/ActiveFilters';
import { EmptyLibrary } from '../components/models/EmptyLibrary';
import { BulkActions } from '../components/models/BulkActions';
import { Button } from '../components/ui/button';
import { Loader2 } from 'lucide-react';

export function LibraryPage() {
  const {
    filters,
    toApiParams,
    setQ,
    setSort,
    toggleTag,
    clearMetaFilter,
    setMetaFilter,
    clearAllFilters,
    hasActiveFilters,
  } = useModelFilters();

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [bulkMode, setBulkMode] = useState(false);
  const { selected, toggle, selectAll, clear, isSelected, count } = useBulkSelection();

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
  } = useInfiniteQuery({
    queryKey: ['models', filters],
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const params: ModelSearchParams = toApiParams(pageParam);
      return getModels(params);
    },
    getNextPageParam: (lastPage) => lastPage.meta?.cursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    staleTime: 30_000,
  });

  // IntersectionObserver for infinite scroll
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

  const allModels: ModelCard[] = data?.pages.flatMap((page) => page.data) ?? [];
  const totalCount = data?.pages[0]?.meta?.total ?? 0;

  function handleSortChange(
    sort: ModelSearchParams['sort'],
    sortDir: ModelSearchParams['sortDir']
  ) {
    setSort(sort, sortDir);
  }

  function toggleBulkMode() {
    if (bulkMode) {
      clear();
    }
    setBulkMode((v) => !v);
  }

  function handleSelectAll() {
    selectAll(allModels.map((m) => m.id));
  }

  function handleDeleted() {
    clear();
    setBulkMode(false);
  }

  return (
    <div className="flex gap-6 min-h-full">
      {/* Filter sidebar */}
      <FilterPanel
        activeTags={filters.tags}
        metadataFilters={filters.metadataFilters}
        onToggleTag={toggleTag}
        onSetMetaFilter={setMetaFilter}
        className="w-52 shrink-0 hidden lg:flex flex-col"
      />

      {/* Main content */}
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        {/* Page header */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-baseline gap-3">
              <h1 className="text-2xl font-bold text-foreground">Library</h1>
              {!isLoading && totalCount > 0 && (
                <span className="text-sm text-muted-foreground">
                  {totalCount.toLocaleString()} {totalCount === 1 ? 'model' : 'models'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <SearchBar
                value={filters.q}
                onChange={setQ}
                className="w-64"
              />
              <SortControls
                sort={filters.sort}
                sortDir={filters.sortDir}
                onSortChange={handleSortChange}
              />
              {/* Bulk mode toggle */}
              {allModels.length > 0 && (
                <Button
                  variant={bulkMode ? 'secondary' : 'outline'}
                  size="sm"
                  onClick={toggleBulkMode}
                >
                  {bulkMode ? (
                    <>
                      <CheckSquare className="h-4 w-4 mr-1.5" />
                      Done
                    </>
                  ) : (
                    <>
                      <Square className="h-4 w-4 mr-1.5" />
                      Select
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>

          {/* Select all row (shown in bulk mode) */}
          {bulkMode && allModels.length > 0 && (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <button
                type="button"
                className="hover:text-foreground transition-colors"
                onClick={handleSelectAll}
              >
                Select all {allModels.length} visible
              </button>
              {count > 0 && (
                <>
                  <span>·</span>
                  <button
                    type="button"
                    className="hover:text-foreground transition-colors"
                    onClick={clear}
                  >
                    Clear selection
                  </button>
                </>
              )}
            </div>
          )}

          {/* Active filter chips */}
          <ActiveFilters
            q={filters.q}
            tags={filters.tags}
            metadataFilters={filters.metadataFilters}
            onClearQ={() => setQ('')}
            onRemoveTag={toggleTag}
            onClearMetaFilter={clearMetaFilter}
            onClearAll={clearAllFilters}
          />
        </div>

        {/* Error state */}
        {isError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            Failed to load models. Please try refreshing the page.
          </div>
        )}

        {/* Loading skeleton */}
        {isLoading && (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {Array.from({ length: 8 }).map((_, i) => (
              <ModelCardSkeleton key={i} />
            ))}
          </div>
        )}

        {/* Grid */}
        {!isLoading && allModels.length > 0 && (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {allModels.map((model) => (
              <ModelCardComponent
                key={model.id}
                model={model}
                selectable={bulkMode}
                selected={isSelected(model.id)}
                onToggleSelect={toggle}
              />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !isError && allModels.length === 0 && (
          <EmptyLibrary hasFilters={hasActiveFilters} />
        )}

        {/* Infinite scroll sentinel */}
        <div ref={sentinelRef} className="h-1" aria-hidden />

        {/* Fetching next page indicator */}
        {isFetchingNextPage && (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* End of results indicator */}
        {!hasNextPage && allModels.length > 0 && !isFetchingNextPage && (
          <p className="text-center text-xs text-muted-foreground py-4">
            All {totalCount.toLocaleString()} models loaded
          </p>
        )}
      </div>

      {/* Bulk actions bar */}
      <BulkActions
        selectedIds={selected}
        onClear={() => { clear(); setBulkMode(false); }}
        onDeleted={handleDeleted}
      />
    </div>
  );
}
