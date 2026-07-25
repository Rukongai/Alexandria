import { getMetadataAxisSlug } from '../../hooks/use-model-filters';
import type { PivotAxis, ActiveAxisValue, BuiltInPivotAxis } from '../../hooks/use-model-filters';
import {
  CollectionsIcon,
  ArtistIcon,
  TagIcon,
  SmartIcon,
  MetadataIcon,
  ChevronRightIcon,
} from '../icons';

interface BreadcrumbProps {
  axis: PivotAxis;
  activeAxisValue: ActiveAxisValue;
  metadataFieldName?: string;
}

const AXIS_LABELS: Record<BuiltInPivotAxis, string> = {
  collections: 'Collections',
  artists: 'Artists',
  tags: 'Tags',
  smart: 'Smart Collections',
};

const AXIS_ICONS: Record<BuiltInPivotAxis, React.ReactNode> = {
  collections: <CollectionsIcon className="h-3.5 w-3.5" />,
  artists: <ArtistIcon className="h-3.5 w-3.5" />,
  tags: <TagIcon className="h-3.5 w-3.5" />,
  smart: <SmartIcon className="h-3.5 w-3.5" />,
};

/**
 * Context breadcrumb for the pivot workspace main area.
 *
 * Renders: Library › <AxisLabel> › <selected value (if any)>
 *
 * Accepts axis and activeAxisValue as props so it's easily testable
 * without needing router/URL context.
 */
export function Breadcrumb({ axis, activeAxisValue, metadataFieldName }: BreadcrumbProps) {
  const metadataSlug = getMetadataAxisSlug(axis);
  const axisLabel = metadataSlug ? metadataFieldName ?? metadataSlug : AXIS_LABELS[axis as BuiltInPivotAxis];
  const axisIcon = metadataSlug
    ? <MetadataIcon className="h-3.5 w-3.5" />
    : AXIS_ICONS[axis as BuiltInPivotAxis];

  // Derive the current value label from the active axis value
  let valueLabel: string | null = null;
  if (axis === 'collections' && activeAxisValue.collectionId) {
    // Collection name resolution would require a fetch — show "Collection" as a
    // simple crumb. A later task can enrich this with real names.
    valueLabel = 'Collection';
  } else if (axis === 'artists' && activeAxisValue.artist) {
    valueLabel = activeAxisValue.artist;
  } else if (axis === 'tags' && activeAxisValue.tags.length > 0) {
    valueLabel = activeAxisValue.tags.join(', ');
  } else if (metadataSlug && activeAxisValue.metadata?.value) {
    valueLabel = activeAxisValue.metadata.value;
  }

  const crumbs: Array<{ label: string; icon?: React.ReactNode }> = [
    { label: 'Library' },
    { label: axisLabel, icon: axisIcon },
    ...(valueLabel ? [{ label: valueLabel }] : []),
  ];

  return (
    <nav
      aria-label="Pivot breadcrumb"
      className="flex items-center gap-1 flex-wrap"
      style={{ fontSize: '12.5px', color: 'var(--ax-fg-muted)' }}
    >
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={i} className="flex items-center gap-1">
            {/* Separator before each crumb except the first */}
            {i > 0 && (
              <ChevronRightIcon
                className="h-3 w-3 flex-shrink-0"
                style={{ color: 'var(--ax-fg-subtle)' }}
                aria-hidden
              />
            )}
            {crumb.icon && (
              <span
                className="flex items-center flex-shrink-0"
                style={{ color: 'var(--ax-fg-muted)' }}
                aria-hidden
              >
                {crumb.icon}
              </span>
            )}
            <span
              style={{
                color: isLast ? 'var(--ax-fg)' : 'var(--ax-fg-muted)',
                fontWeight: isLast ? 600 : 400,
              }}
            >
              {crumb.label}
            </span>
          </span>
        );
      })}
    </nav>
  );
}
