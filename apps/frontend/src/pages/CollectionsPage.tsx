import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Plus, FolderOpen, Pencil, Trash2, ExternalLink } from 'lucide-react';
import type { CollectionDetail } from '@alexandria/shared';
import { getCollections, deleteCollection } from '../api/collections';
import { useToast } from '../hooks/use-toast';
import { CollectionTree } from '../components/collections/CollectionTree';
import { CollectionDialog } from '../components/collections/CollectionDialog';
import { AlertDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';

export function CollectionsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<CollectionDetail | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<CollectionDetail | undefined>(undefined);

  const { data, isLoading } = useQuery({
    queryKey: ['collections'],
    queryFn: () => getCollections(),
    select: (res) => res.data,
  });

  const collections: CollectionDetail[] = data ?? [];
  const selectedCollection = collections.find((c) => c.id === selectedId);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCollection(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      toast({ title: 'Collection deleted' });
      if (selectedId === deleteTarget?.id) setSelectedId(undefined);
      setDeleteTarget(undefined);
    },
    onError: () => {
      toast({ title: 'Failed to delete collection', variant: 'destructive' });
    },
  });

  return (
    <div className="flex gap-0 min-h-full -mx-6 -my-6">
      {/* Left panel — tree */}
      <div className="w-64 shrink-0 border-r bg-muted/30 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h2 className="text-sm font-semibold text-foreground">Collections</h2>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => setCreateOpen(true)}
            aria-label="Create collection"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto py-2 px-2">
          {isLoading ? (
            <div className="flex flex-col gap-2 px-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-full rounded-md" />
              ))}
            </div>
          ) : (
            <CollectionTree
              collections={collections}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </div>

        <div className="border-t p-3">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-4 w-4 mr-1.5" />
            New Collection
          </Button>
        </div>
      </div>

      {/* Right panel — detail */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {!selectedCollection ? (
          <div className="flex flex-col items-center justify-center h-full min-h-[300px] gap-4 text-center">
            <FolderOpen className="h-12 w-12 text-muted-foreground/40" />
            <div>
              <p className="text-base font-medium text-foreground">No collection selected</p>
              <p className="text-sm text-muted-foreground mt-1">
                Choose a collection from the left, or create a new one.
              </p>
            </div>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-1.5" />
              New Collection
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {/* Header */}
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <h1 className="text-2xl font-bold text-foreground">{selectedCollection.name}</h1>
                {selectedCollection.description && (
                  <p className="text-sm text-muted-foreground">{selectedCollection.description}</p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  {selectedCollection.modelCount} {selectedCollection.modelCount === 1 ? 'model' : 'models'}
                  {selectedCollection.children.length > 0 && (
                    <> · {selectedCollection.children.length} sub-{selectedCollection.children.length === 1 ? 'collection' : 'collections'}</>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/collections/${selectedCollection.id}`)}
                >
                  <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                  Open
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditTarget(selectedCollection)}
                >
                  <Pencil className="h-3.5 w-3.5 mr-1.5" />
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setDeleteTarget(selectedCollection)}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  Delete
                </Button>
              </div>
            </div>

            {/* Sub-collections */}
            {selectedCollection.children.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-2">Sub-collections</h3>
                <div className="flex flex-wrap gap-2">
                  {selectedCollection.children.map((child) => (
                    <button
                      key={child.id}
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-3 py-1.5 text-sm hover:bg-accent transition-colors"
                      onClick={() => setSelectedId(child.id)}
                    >
                      <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                      {child.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* View full detail link */}
            <div className="rounded-lg border bg-muted/30 p-6 flex flex-col items-center gap-3 text-center">
              <p className="text-sm text-muted-foreground">
                View all models in this collection on the collection detail page.
              </p>
              <Button
                onClick={() => navigate(`/collections/${selectedCollection.id}`)}
              >
                <ExternalLink className="h-4 w-4 mr-1.5" />
                Open Collection Detail
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Create dialog */}
      <CollectionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        allCollections={collections}
        onSuccess={(result) => setSelectedId(result.id)}
      />

      {/* Edit dialog */}
      {editTarget && (
        <CollectionDialog
          open={!!editTarget}
          onOpenChange={(open) => { if (!open) setEditTarget(undefined); }}
          collection={editTarget}
          allCollections={collections}
        />
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <AlertDialog
          open={!!deleteTarget}
          onOpenChange={(open) => { if (!open) setDeleteTarget(undefined); }}
          title={`Delete "${deleteTarget.name}"?`}
          description="This will delete the collection. Models inside will not be deleted, but they will be removed from this collection."
          confirmLabel="Delete Collection"
          destructive
          isLoading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
        />
      )}
    </div>
  );
}
