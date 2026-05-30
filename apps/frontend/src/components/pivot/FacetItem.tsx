import { cn } from '../../lib/utils';
import { ChevronRightIcon } from '../icons';

export interface FacetItemProps {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  count?: number;
  active?: boolean;
  onClick?: () => void;
  indent?: number;
  hasChildren?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
}

/**
 * Presentational list row for pivot rail facets.
 * No data fetching — all behavior comes from props.
 */
export function FacetItem({
  icon: Icon,
  label,
  count,
  active = false,
  onClick,
  indent = 0,
  hasChildren = false,
  expanded = false,
  onToggleExpand,
}: FacetItemProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-1.5 rounded-md pr-2 transition-colors duration-100',
        'text-left select-none focus-visible:outline-none focus-visible:ring-1',
        'focus-visible:ring-[var(--ax-rail-active)]',
        active
          ? 'bg-[var(--ax-rail-active)] text-[var(--ax-rail-fg)]'
          : 'text-[var(--ax-rail-fg-muted)] hover:bg-[var(--ax-rail-hover)] hover:text-[var(--ax-rail-fg)]'
      )}
      style={{
        height: 'var(--ax-row-h)',
        paddingLeft: `${8 + indent * 16}px`,
        fontSize: '12.5px',
      }}
    >
      {/* Expand chevron — always takes up a fixed slot */}
      <span
        className="flex-shrink-0 flex items-center justify-center"
        style={{ width: 12 }}
        onClick={
          hasChildren && onToggleExpand
            ? (e) => {
                e.stopPropagation();
                onToggleExpand();
              }
            : undefined
        }
      >
        {hasChildren && (
          <ChevronRightIcon
            className={cn(
              'h-3 w-3 transition-transform duration-100',
              expanded && 'rotate-90'
            )}
          />
        )}
      </span>

      {/* Domain icon */}
      {Icon && (
        <Icon
          className={cn(
            'flex-shrink-0 h-3 w-3',
            active ? 'text-[var(--ax-rail-fg)]' : 'text-[var(--ax-rail-fg-muted)]'
          )}
        />
      )}

      {/* Label */}
      <span className="flex-1 truncate">{label}</span>

      {/* Count badge — right-aligned, tabular nums */}
      {count != null && (
        <span className="ax-mono flex-shrink-0 text-[var(--ax-rail-fg-muted)]" style={{ fontSize: '11.5px' }}>
          {count}
        </span>
      )}
    </button>
  );
}
