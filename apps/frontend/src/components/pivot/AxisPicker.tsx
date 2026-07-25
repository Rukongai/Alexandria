import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useSearchParams } from 'react-router-dom';
import { cn } from '../../lib/utils';
import { getFields } from '../../api/metadata';
import { useLibraryPath } from '../../hooks/use-libraries';
import {
  getMetadataAxisSlug,
  isValidMetadataAxisSlug,
  useModelFilters,
  type PivotAxis,
} from '../../hooks/use-model-filters';
import { CollectionsIcon, ArtistIcon, TagIcon, SmartIcon, MetadataIcon } from '../icons';

interface AxisOption {
  id: PivotAxis;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const BUILT_IN_AXIS_OPTIONS: AxisOption[] = [
  { id: 'collections', label: 'Collections', icon: CollectionsIcon },
  { id: 'artists', label: 'Artists', icon: ArtistIcon },
  { id: 'tags', label: 'Tags', icon: TagIcon },
  { id: 'smart', label: 'Smart', icon: SmartIcon },
];

/**
 * 2-column grid of axis-picker buttons for the pivot rail.
 * Reads axis/setAxis from useModelFilters internally.
 */
export function AxisPicker() {
  const { axis, setAxis } = useModelFilters();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const libPath = useLibraryPath();
  const browsePath = libPath('/');
  const { data: fieldsData, isSuccess } = useQuery({
    queryKey: ['metadata-fields'],
    queryFn: getFields,
  });
  const fields = fieldsData ?? [];
  const metadataAxes: AxisOption[] = fields
    .filter((field) => field.isBrowsable && isValidMetadataAxisSlug(field.slug))
    .map((field) => ({
      id: `metadata:${field.slug}`,
      label: field.name,
      icon: MetadataIcon,
    }));
  const axisOptions = [...BUILT_IN_AXIS_OPTIONS, ...metadataAxes];

  useEffect(() => {
    if (!isSuccess || location.pathname !== browsePath) return;
    const rawAxis = searchParams.get('axis');
    if (!rawAxis?.startsWith('metadata:')) return;
    const slug = getMetadataAxisSlug(rawAxis as PivotAxis);
    const fieldIsBrowsable = slug
      ? fields.some((field) => field.slug === slug && field.isBrowsable)
      : false;
    if (!fieldIsBrowsable) {
      setSearchParams((previous) => {
        const next = new URLSearchParams(previous);
        next.delete('axis');
        return next;
      }, { replace: true });
    }
  }, [browsePath, fields, isSuccess, location.pathname, searchParams, setSearchParams]);

  return (
    <div className="px-3 py-2">
      <p
        className="ax-mono px-2 mb-1"
        style={{ fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ax-rail-fg-muted)' }}
      >
        Browse by
      </p>
      <div
        role="group"
        aria-label="Browse axes"
        className="grid max-h-48 gap-1 overflow-y-auto rounded-lg p-1 ax-scroll"
        style={{
          gridTemplateColumns: '1fr 1fr',
          background: 'var(--ax-rail-elev)',
          border: '1px solid var(--ax-rail-border)',
        }}
      >
        {axisOptions.map(({ id, label, icon: Icon }) => {
          const isActive = axis === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={isActive}
              onClick={() => setAxis(id)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors duration-100',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ax-rail-active)]',
                isActive
                  ? 'text-white'
                  : 'text-[var(--ax-rail-fg)] hover:bg-[var(--ax-rail-hover)]'
              )}
              style={{
                fontSize: '11.5px',
                fontWeight: 500,
                background: isActive ? 'var(--ax-rail-active)' : 'transparent',
              }}
            >
              <Icon
                className={cn(
                  'h-3 w-3 flex-shrink-0',
                  isActive ? 'text-white' : 'text-[var(--ax-rail-fg-muted)]'
                )}
              />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
