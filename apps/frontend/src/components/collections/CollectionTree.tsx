import { useState } from 'react';
import { ChevronRight, ChevronDown, FolderOpen, Folder } from 'lucide-react';
import type { CollectionDetail } from '@alexandria/shared';
import { cn } from '../../lib/utils';

interface CollectionTreeProps {
  collections: CollectionDetail[];
  selectedId?: string;
  onSelect: (id: string) => void;
}

interface CollectionTreeItemProps {
  collection: CollectionDetail;
  selectedId?: string;
  onSelect: (id: string) => void;
  depth: number;
  allCollections: CollectionDetail[];
}

function CollectionTreeItem({
  collection,
  selectedId,
  onSelect,
  depth,
  allCollections,
}: CollectionTreeItemProps) {
  const [expanded, setExpanded] = useState(false);
  const isSelected = selectedId === collection.id;
  const hasChildren = collection.children.length > 0;

  // Find full CollectionDetail objects for children
  const childDetails = collection.children
    .map((child) => allCollections.find((c) => c.id === child.id))
    .filter((c): c is CollectionDetail => c !== undefined);

  return (
    <li>
      <div
        className={cn(
          'flex items-center gap-1 rounded-md px-2 py-1.5 cursor-pointer transition-colors',
          'hover:bg-accent/50 select-none',
          isSelected && 'bg-accent text-accent-foreground'
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onSelect(collection.id)}
      >
        {/* Expand toggle */}
        <span
          className="h-4 w-4 shrink-0 flex items-center justify-center"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) setExpanded((v) => !v);
          }}
        >
          {hasChildren ? (
            expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )
          ) : null}
        </span>

        {/* Folder icon */}
        {isSelected || expanded ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}

        {/* Name + count */}
        <span className="flex-1 truncate text-sm font-medium">{collection.name}</span>
        <span className="text-xs text-muted-foreground tabular-nums ml-1">
          {collection.modelCount}
        </span>
      </div>

      {/* Children */}
      {hasChildren && expanded && (
        <ul className="mt-0.5">
          {childDetails.map((child) => (
            <CollectionTreeItem
              key={child.id}
              collection={child}
              selectedId={selectedId}
              onSelect={onSelect}
              depth={depth + 1}
              allCollections={allCollections}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function CollectionTree({ collections, selectedId, onSelect }: CollectionTreeProps) {
  // Only render top-level collections (no parent)
  const topLevel = collections.filter((c) => c.parentCollectionId === null);

  if (topLevel.length === 0) {
    return (
      <p className="px-3 py-4 text-sm text-muted-foreground">No collections yet.</p>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {topLevel.map((collection) => (
        <CollectionTreeItem
          key={collection.id}
          collection={collection}
          selectedId={selectedId}
          onSelect={onSelect}
          depth={0}
          allCollections={collections}
        />
      ))}
    </ul>
  );
}
