import { Link } from 'react-router-dom';
import { FolderOpen } from 'lucide-react';
import type { CollectionSummary } from '@alexandria/shared';

interface CollectionsListProps {
  collections: CollectionSummary[];
}

export function CollectionsList({ collections }: CollectionsListProps) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
        <span className="text-sm font-semibold text-foreground">Collections</span>
        <span className="text-xs text-muted-foreground">{collections.length}</span>
      </div>

      <div className="px-4 py-3">
        {collections.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not in any collection.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {collections.map((col) => (
              <li key={col.id}>
                <Link
                  to={`/collections/${col.id}`}
                  className="flex items-center gap-2 text-sm text-foreground hover:text-primary transition-colors py-0.5 group"
                >
                  <FolderOpen className="h-4 w-4 text-amber-500 flex-shrink-0 group-hover:text-primary transition-colors" />
                  <span className="truncate">{col.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
