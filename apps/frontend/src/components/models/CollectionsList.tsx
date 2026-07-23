import * as React from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Check, FolderOpen, Loader2, Plus } from 'lucide-react';
import type { CollectionDetail, CollectionSummary } from '@alexandria/shared';
import { useLibraryPath } from '../../hooks/use-libraries';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';

interface CollectionsListProps {
  collections: CollectionSummary[];
  allCollections: CollectionDetail[];
  isLoading: boolean;
  isError: boolean;
  isAdding: boolean;
  onRetry: () => void;
  onAdd: (collectionIds: string[]) => Promise<void>;
}

export function CollectionsList({
  collections,
  allCollections,
  isLoading,
  isError,
  isAdding,
  onRetry,
  onAdd,
}: CollectionsListProps) {
  const libPath = useLibraryPath();
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [submitError, setSubmitError] = React.useState(false);
  const existingIds = React.useMemo(
    () => new Set(collections.map((collection) => collection.id)),
    [collections],
  );
  const sortedCollections = React.useMemo(
    () => [...allCollections].sort((a, b) => a.name.localeCompare(b.name)),
    [allCollections],
  );

  React.useEffect(() => {
    setSelectedIds((current) => {
      const next = new Set(
        [...current].filter((id) => !existingIds.has(id) && allCollections.some((item) => item.id === id)),
      );
      return next.size === current.size ? current : next;
    });
  }, [allCollections, existingIds]);

  function toggleCollection(id: string, checked: boolean) {
    setSubmitError(false);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function addSelectedCollections() {
    if (selectedIds.size === 0) return;
    setSubmitError(false);
    try {
      await onAdd([...selectedIds]);
      setSelectedIds(new Set());
    } catch {
      setSubmitError(true);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
        <span className="text-sm font-semibold text-foreground">Collections</span>
        <span className="text-xs text-muted-foreground">{collections.length}</span>
      </div>

      <div className="px-4 py-3">
        {collections.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not in any collection yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {collections.map((col) => (
              <li key={col.id}>
                <Link
                  to={libPath(`/collections/${col.id}`)}
                  className="flex items-center gap-2 text-sm text-foreground hover:text-primary transition-colors py-0.5 group"
                >
                  <FolderOpen className="h-4 w-4 text-muted-foreground flex-shrink-0 group-hover:text-primary transition-colors" />
                  <span className="truncate">{col.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-border bg-muted/15 px-4 py-3">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Add to collections</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Existing memberships are kept.
            </p>
          </div>
          <Plus className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </div>

        {isLoading && (
          <div
            className="flex min-h-20 items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading collections…
          </div>
        )}

        {!isLoading && isError && (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              Collections could not be loaded.
            </p>
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}

        {!isLoading && !isError && sortedCollections.length === 0 && (
          <p className="text-sm text-muted-foreground">No collections are available yet.</p>
        )}

        {!isLoading && !isError && sortedCollections.length > 0 && (
          <>
            <fieldset disabled={isAdding} aria-label="Collections to add">
              <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
                {sortedCollections.map((collection) => {
                  const isExisting = existingIds.has(collection.id);
                  return (
                    <li
                      key={collection.id}
                      className="flex min-h-9 items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-accent/50"
                    >
                      <Checkbox
                        id={`model-collection-${collection.id}`}
                        label={collection.name}
                        checked={isExisting || selectedIds.has(collection.id)}
                        disabled={isExisting || isAdding}
                        onChange={(event) => toggleCollection(collection.id, event.currentTarget.checked)}
                      />
                      {isExisting && (
                        <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground">
                          <Check className="h-3 w-3" aria-hidden="true" />
                          Already added
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </fieldset>

            {submitError && (
              <p className="mt-2 text-xs text-destructive" role="alert">
                The model could not be added to every selected collection. Try again.
              </p>
            )}

            <Button
              type="button"
              size="sm"
              className="mt-3 w-full gap-2"
              disabled={selectedIds.size === 0 || isAdding}
              onClick={addSelectedCollections}
            >
              {isAdding && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {selectedIds.size === 0
                ? 'Select collections'
                : `Add to ${selectedIds.size} collection${selectedIds.size === 1 ? '' : 's'}`}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
