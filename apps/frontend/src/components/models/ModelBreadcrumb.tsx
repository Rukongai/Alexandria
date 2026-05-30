import { Link } from 'react-router-dom';
import type { CollectionSummary } from '@alexandria/shared';
import { LibraryIcon, CollectionsIcon, ChevronRightIcon } from '../icons';

interface ModelBreadcrumbProps {
  /** The model's primary collection (collections[0]), or null if it has none. */
  collection: CollectionSummary | null;
  modelName: string;
}

/**
 * Context breadcrumb for the model detail page.
 *
 * Renders: Library › <Collection> › <Model name>
 * (the collection crumb is omitted when the model has no collections).
 *
 * Modeled stylistically on the pivot workspace Breadcrumb, but the
 * intermediate crumbs are real navigation links.
 */
export function ModelBreadcrumb({ collection, modelName }: ModelBreadcrumbProps) {
  const crumbs: Array<{
    label: string;
    to?: string;
    icon?: React.ReactNode;
  }> = [
    { label: 'Library', to: '/', icon: <LibraryIcon className="h-3.5 w-3.5" /> },
    ...(collection
      ? [
          {
            label: collection.name,
            to: `/collections/${collection.id}`,
            icon: <CollectionsIcon className="h-3.5 w-3.5" />,
          },
        ]
      : []),
    { label: modelName },
  ];

  return (
    <nav
      aria-label="Model breadcrumb"
      className="flex items-center gap-1 flex-wrap"
      style={{ fontSize: '12.5px', color: 'var(--ax-fg-muted)' }}
    >
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={i} className="flex items-center gap-1 min-w-0">
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
            {crumb.to && !isLast ? (
              <Link
                to={crumb.to}
                className="truncate transition-colors hover:underline"
                style={{ color: 'var(--ax-fg-muted)' }}
              >
                {crumb.label}
              </Link>
            ) : (
              <span
                className="truncate"
                style={{
                  color: isLast ? 'var(--ax-fg)' : 'var(--ax-fg-muted)',
                  fontWeight: isLast ? 600 : 400,
                }}
                aria-current={isLast ? 'page' : undefined}
              >
                {crumb.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
