import { cn } from '../../lib/utils';
import { useModelFilters, type PivotAxis } from '../../hooks/use-model-filters';
import { CollectionsIcon, ArtistIcon, TagIcon, SmartIcon } from '../icons';

interface AxisOption {
  id: PivotAxis;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const AXIS_OPTIONS: AxisOption[] = [
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

  return (
    <div className="px-3 py-2">
      <p
        className="ax-mono px-2 mb-1"
        style={{ fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ax-rail-fg-muted)' }}
      >
        Browse by
      </p>
      <div
        className="grid gap-1 rounded-lg p-1"
        style={{
          gridTemplateColumns: '1fr 1fr',
          background: 'var(--ax-rail-elev)',
          border: '1px solid var(--ax-rail-border)',
        }}
      >
        {AXIS_OPTIONS.map(({ id, label, icon: Icon }) => {
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
