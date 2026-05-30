import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useModelFilters } from '../../hooks/use-model-filters';
import { useModelResults } from '../../hooks/use-model-results';
import { useDisplayPreferences } from '../../hooks/use-display-preferences';
import { useBulkSelection } from '../../hooks/use-bulk-selection';
import { ModelCard } from '../models/ModelCard';
import { ModelList } from '../models/ModelList';
import { ModelGroupView } from '../models/ModelGroupView';
import { ModelCardSkeleton } from '../models/ModelCardSkeleton';
import { EmptyLibrary } from '../models/EmptyLibrary';
import { Breadcrumb } from './Breadcrumb';
import { ViewSwitch } from './ViewSwitch';
import {
  SearchIcon,
  UploadIcon,
  CollectionsIcon,
  ArtistIcon,
  TagIcon,
} from '../icons';
import type { PivotAxis } from '../../hooks/use-model-filters';

const AXIS_ICONS: Record<PivotAxis, React.ElementType> = {
  collections: CollectionsIcon,
  artists: ArtistIcon,
  tags: TagIcon,
};

const AXIS_LABELS: Record<PivotAxis, string> = {
  collections: 'Collections',
  artists: 'Artists',
  tags: 'Tags',
};

/** Derive a human-readable context title from the active axis + selection. */
function deriveContextTitle(
  axis: PivotAxis,
  activeAxisValue: ReturnType<typeof useModelFilters>['activeAxisValue']
): string {
  if (axis === 'collections') {
    return activeAxisValue.collectionId ? 'Collection' : 'All Collections';
  }
  if (axis === 'artists') {
    return activeAxisValue.artist ?? 'All Artists';
  }
  if (axis === 'tags') {
    return activeAxisValue.tags.length > 0
      ? activeAxisValue.tags.join(', ')
      : 'All Tags';
  }
  return AXIS_LABELS[axis];
}

/**
 * Pivot workspace main content area.
 *
 * Composed of:
 *   1. Top bar — Breadcrumb (left), search input (center-right), Upload action (right)
 *   2. Context header — large axis icon badge + title + result count + ViewSwitch
 *   3. Results region — model grid (grid view only; F18 slots in list/group)
 *
 * This component is self-contained and wired in by F19 when composing the
 * full pivot workspace page.
 */
export function PivotMain() {
  const { filters, toApiParams, setQ, axis, activeAxisValue, hasActiveFilters } =
    useModelFilters();
  const { view, showThumbnails } = useDisplayPreferences();

  const [bulkMode, setBulkMode] = useState(false);
  const { selected, toggle, selectAll, clear, isSelected, count } = useBulkSelection();

  const {
    models,
    total,
    isLoading,
    isError,
    isFetchingNextPage,
    hasNextPage,
    sentinelRef,
  } = useModelResults({ filters, toApiParams });

  function handleSelectAll() {
    selectAll(models.map((m) => m.id));
  }

  function toggleBulkMode() {
    if (bulkMode) clear();
    setBulkMode((v) => !v);
  }

  const AxisIcon = AXIS_ICONS[axis];
  const contextTitle = deriveContextTitle(axis, activeAxisValue);

  // Axis icon badge background per axis
  const AXIS_BG: Record<PivotAxis, string> = {
    collections: 'linear-gradient(135deg, var(--ax-amber), var(--ax-amber-deep, #b45309))',
    artists: 'linear-gradient(135deg, var(--ax-teal, #0d9488), #0f766e)',
    tags: 'linear-gradient(135deg, var(--ax-teal, #0d9488), #0f766e)',
  };

  return (
    <div className="flex flex-col h-full min-h-0" style={{ background: 'var(--ax-bg)', color: 'var(--ax-fg)' }}>
      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <div
        className="flex-shrink-0 flex items-center gap-3 px-6 py-2.5"
        style={{
          borderBottom: '1px solid var(--ax-border)',
          background: 'var(--ax-bg)',
        }}
      >
        {/* Left: breadcrumb */}
        <div className="flex-1 min-w-0">
          <Breadcrumb axis={axis} activeAxisValue={activeAxisValue} />
        </div>

        {/* Right: search + upload */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Search input */}
          <label className="relative flex items-center">
            <span className="sr-only">Search models</span>
            <SearchIcon
              className="absolute left-2.5 h-3.5 w-3.5 pointer-events-none"
              style={{ color: 'var(--ax-fg-muted)' }}
              aria-hidden
            />
            <input
              type="search"
              placeholder="Search…"
              value={filters.q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search models"
              className="h-8 rounded-lg pl-8 pr-3 text-sm outline-none transition-colors"
              style={{
                width: 200,
                background: 'var(--ax-bg-elev)',
                border: '1px solid var(--ax-border)',
                color: 'var(--ax-fg)',
              }}
            />
          </label>

          {/* Upload action */}
          <Link
            to="/upload"
            className="flex items-center gap-1.5 rounded-lg px-3 h-8 text-sm font-medium transition-colors"
            style={{
              background: 'var(--ax-amber)',
              color: 'var(--ax-amber-fg, white)',
              textDecoration: 'none',
            }}
            aria-label="Upload model"
          >
            <UploadIcon className="h-3.5 w-3.5" aria-hidden />
            <span>Upload</span>
          </Link>
        </div>
      </div>

      {/* ── Context header ───────────────────────────────────────────── */}
      <div
        className="flex-shrink-0 flex items-end justify-between gap-4 px-6 pt-5 pb-4"
        style={{ borderBottom: '1px solid var(--ax-border)' }}
      >
        {/* Icon + title + count */}
        <div className="flex items-center gap-4">
          <div
            className="flex items-center justify-center rounded-2xl flex-shrink-0"
            style={{
              width: 56,
              height: 56,
              background: AXIS_BG[axis],
              boxShadow: 'var(--ax-shadow-md)',
              color: 'white',
            }}
            aria-hidden
          >
            <AxisIcon className="h-6 w-6" />
          </div>

          <div>
            <h1
              className="font-bold leading-tight"
              style={{ fontSize: 22, letterSpacing: '-0.01em' }}
            >
              {contextTitle}
            </h1>
            {!isLoading && (
              <p className="mt-0.5 text-sm" style={{ color: 'var(--ax-fg-muted)' }}>
                <span className="font-medium" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {total.toLocaleString()}
                </span>{' '}
                {total === 1 ? 'model' : 'models'}
              </p>
            )}
          </div>
        </div>

        {/* View switch + bulk mode toggle */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {models.length > 0 && (
            <button
              type="button"
              onClick={toggleBulkMode}
              className="flex items-center gap-1.5 h-8 rounded-lg px-3 text-sm font-medium transition-colors"
              style={{
                background: bulkMode ? 'var(--ax-bg-sunk)' : 'var(--ax-bg-elev)',
                border: '1px solid var(--ax-border)',
                color: 'var(--ax-fg)',
                cursor: 'pointer',
              }}
            >
              {bulkMode ? 'Done' : 'Select'}
            </button>
          )}
          <ViewSwitch />
        </div>
      </div>

      {/* Bulk-select controls row */}
      {bulkMode && models.length > 0 && (
        <div
          className="flex-shrink-0 flex items-center gap-3 px-6 py-2 text-sm"
          style={{ color: 'var(--ax-fg-muted)', borderBottom: '1px solid var(--ax-border)' }}
        >
          <button
            type="button"
            className="transition-colors hover:text-foreground"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', color: 'inherit', padding: 0 }}
            onClick={handleSelectAll}
          >
            Select all {models.length} visible
          </button>
          {count > 0 && (
            <>
              <span aria-hidden>·</span>
              <button
                type="button"
                className="transition-colors hover:text-foreground"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', color: 'inherit', padding: 0 }}
                onClick={clear}
              >
                Clear selection
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Results region ───────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        {/* Error state */}
        {isError && (
          <div
            className="rounded-lg p-4 text-sm"
            style={{
              border: '1px solid var(--ax-danger, #ef4444)',
              background: 'color-mix(in srgb, var(--ax-danger, #ef4444) 10%, transparent)',
              color: 'var(--ax-danger, #ef4444)',
            }}
          >
            Failed to load models. Please try refreshing the page.
          </div>
        )}

        {/* Loading skeleton */}
        {isLoading && (
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
          >
            {Array.from({ length: 8 }).map((_, i) => (
              <ModelCardSkeleton key={i} />
            ))}
          </div>
        )}

        {/* Results branch point — F18 slots in list/group view here */}
        {!isLoading && models.length > 0 && (
          <>
            {/* F18: list view */}
            {view === 'list' && (
              <ModelList
                models={models}
                selectable={bulkMode}
                isSelected={isSelected}
                onToggleSelect={toggle}
                showThumbnails={showThumbnails}
              />
            )}

            {/* F18: group view */}
            {view === 'group' && (
              <ModelGroupView
                models={models}
                axis={axis}
                activeAxisValue={activeAxisValue}
                selectable={bulkMode}
                isSelected={isSelected}
                onToggleSelect={toggle}
              />
            )}

            {/* Grid view (default) */}
            {view === 'grid' && (
              <div
                className="grid gap-4"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
              >
                {models.map((model) => (
                  <ModelCard
                    key={model.id}
                    model={model}
                    selectable={bulkMode}
                    selected={isSelected(model.id)}
                    onToggleSelect={toggle}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* Empty state */}
        {!isLoading && !isError && models.length === 0 && (
          <EmptyLibrary hasFilters={hasActiveFilters} />
        )}

        {/* Infinite scroll sentinel */}
        <div ref={sentinelRef} className="h-1" aria-hidden />

        {/* Fetching next page */}
        {isFetchingNextPage && (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--ax-fg-muted)' }} />
          </div>
        )}

        {/* End of results */}
        {!hasNextPage && models.length > 0 && !isFetchingNextPage && (
          <p
            className="text-center text-xs py-4"
            style={{ color: 'var(--ax-fg-muted)' }}
          >
            All {total.toLocaleString()} models loaded
          </p>
        )}
      </div>
    </div>
  );
}
