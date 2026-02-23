import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Trash2, FolderOpen, Loader2 } from 'lucide-react';
import type { ModelCard } from '@alexandria/shared';
import { getCollection, getCollectionModels, deleteCollection } from '../api/collections';
import { useToast } from '../hooks/use-toast';
import { CollectionDialog } from '../components/collections/CollectionDialog';
import { AlertDialog } from '../components/ui/alert-dialog';
import { ModelCard as ModelCardComponent } from '../components/models/ModelCard';
import { ModelCardSkeleton } from '../components/models/ModelCardSkeleton';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';

export function CollectionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const {
    data: collection,
    isLoading: collectionLoading,
    isError: collectionError,
  } = useQuery({
    queryKey: ['collection', id],
    queryFn: () => getCollection(id!),
    enabled: !!id,
  });

  const {
    data: modelsResponse,
    isLoading: modelsLoading,
  } = useQuery({
    queryKey: ['collection-models', id],
    queryFn: () => getCollectionModels(id!),
    enabled: !!id,
  });

  const models: ModelCard[] = modelsResponse?.data ?? [];

  const deleteMutation = useMutation({
    mutationFn: () => deleteCollection(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      toast({ title: 'Collection deleted' });
      navigate('/collections');
    },
    onError: () => {
      toast({ title: 'Failed to delete collection', variant: 'destructive' });
    },
  });

  if (collectionError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[300px] gap-4">
        <p className="text-destructive">Collection not found or failed to load.</p>
        <Link to="/collections" className="text-sm text-primary hover:underline">
          Back to Collections
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Back nav */}
      <div>
        <Link
          to="/collections"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Collections
        </Link>
      </div>

      {/* Header */}
      {collectionLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
      ) : collection ? (
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <FolderOpen className="h-5 w-5 text-primary" />
              <h1 className="text-2xl font-bold text-foreground">{collection.name}</h1>
            </div>
            {collection.description && (
              <p className="text-sm text-muted-foreground">{collection.description}</p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">
              {collection.modelCount} {collection.modelCount === 1 ? 'model' : 'models'}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="h-3.5 w-3.5 mr-1.5" />
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              Delete
            </Button>
          </div>
        </div>
      ) : null}

      {/* Sub-collections */}
      {collection && collection.children.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-2">Sub-collections</h3>
          <div className="flex flex-wrap gap-2">
            {collection.children.map((child) => (
              <Link
                key={child.id}
                to={`/collections/${child.id}`}
                className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-3 py-1.5 text-sm hover:bg-accent transition-colors"
              >
                <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                {child.name}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Models grid */}
      <div>
        <h2 className="text-base font-semibold text-foreground mb-4">Models</h2>

        {modelsLoading ? (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <ModelCardSkeleton key={i} />
            ))}
          </div>
        ) : models.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-16 gap-3 text-center">
            <FolderOpen className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No models in this collection yet.</p>
          </div>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {models.map((model) => (
              <ModelCardComponent key={model.id} model={model} />
            ))}
          </div>
        )}

        {modelsLoading && (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>

      {/* Edit dialog */}
      {collection && (
        <CollectionDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          collection={collection}
          allCollections={[collection]}
        />
      )}

      {/* Delete confirmation */}
      <AlertDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete "${collection?.name}"?`}
        description="This will delete the collection. Models inside will not be deleted, but they will be removed from this collection."
        confirmLabel="Delete Collection"
        destructive
        isLoading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
      />
    </div>
  );
}
