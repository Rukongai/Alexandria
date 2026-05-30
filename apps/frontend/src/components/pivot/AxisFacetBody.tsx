import { useQuery } from '@tanstack/react-query';
import { getCollections } from '../../api/collections';
import { getFieldValues } from '../../api/metadata';
import { useModelFilters } from '../../hooks/use-model-filters';
import type { PivotAxis } from '../../hooks/use-model-filters';
import { CollectionTree } from '../collections/CollectionTree';
import { ArtistIcon, TagIcon } from '../icons';
import { FacetItem } from './FacetItem';

interface AxisFacetBodyProps {
  axis: PivotAxis;
}

function LoadingRows() {
  return (
    <div className="px-2 py-2 flex flex-col gap-1" aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-[var(--ax-row-h)] rounded-md animate-pulse bg-[var(--ax-rail-hover)]"
          style={{ opacity: 0.6 - i * 0.1 }}
        />
      ))}
    </div>
  );
}

function CollectionsAxis() {
  const { filters, setCollectionId } = useModelFilters();

  const { data, isLoading } = useQuery({
    queryKey: ['collections'],
    queryFn: () => getCollections().then((r) => r.data),
  });

  if (isLoading) return <LoadingRows />;

  if (!data || data.length === 0) {
    return (
      <p className="px-3 py-4 text-xs text-[var(--ax-rail-fg-muted)]">No collections yet.</p>
    );
  }

  return (
    <CollectionTree
      collections={data}
      selectedId={filters.collectionId}
      onSelect={(id) => {
        // Toggle: clicking the already-selected collection clears it
        setCollectionId(filters.collectionId === id ? undefined : id);
      }}
    />
  );
}

function ArtistsAxis() {
  const { filters, setMetaFilter } = useModelFilters();

  const { data, isLoading } = useQuery({
    queryKey: ['field-values', 'artist'],
    queryFn: () => getFieldValues('artist'),
  });

  if (isLoading) return <LoadingRows />;

  if (!data || data.length === 0) {
    return (
      <p className="px-3 py-4 text-xs text-[var(--ax-rail-fg-muted)]">No artists found.</p>
    );
  }

  const activeArtist = filters.metadataFilters['artist'];

  return (
    <div className="flex flex-col gap-px px-1">
      {data.map((item) => (
        <FacetItem
          key={item.value}
          icon={ArtistIcon}
          label={item.value}
          count={item.modelCount}
          active={activeArtist === item.value}
          onClick={() =>
            setMetaFilter('artist', activeArtist === item.value ? undefined : item.value)
          }
        />
      ))}
    </div>
  );
}

function TagsAxis() {
  const { filters, toggleTag } = useModelFilters();

  const { data, isLoading } = useQuery({
    queryKey: ['field-values', 'tags'],
    queryFn: () => getFieldValues('tags'),
  });

  if (isLoading) return <LoadingRows />;

  if (!data || data.length === 0) {
    return (
      <p className="px-3 py-4 text-xs text-[var(--ax-rail-fg-muted)]">No tags found.</p>
    );
  }

  return (
    <div className="flex flex-col gap-px px-1">
      {data.map((item) => (
        <FacetItem
          key={item.value}
          icon={TagIcon}
          label={item.value}
          count={item.modelCount}
          active={filters.tags.includes(item.value)}
          onClick={() => toggleTag(item.value)}
        />
      ))}
    </div>
  );
}

/**
 * Renders the facet list body for the currently active pivot axis.
 * Fetches its own data via React Query; uses setters from useModelFilters
 * to update URL-driven filter state.
 */
export function AxisFacetBody({ axis }: AxisFacetBodyProps) {
  return (
    <div className="flex-1 overflow-y-auto ax-scroll min-h-0">
      {axis === 'collections' && <CollectionsAxis />}
      {axis === 'artists' && <ArtistsAxis />}
      {axis === 'tags' && <TagsAxis />}
    </div>
  );
}
