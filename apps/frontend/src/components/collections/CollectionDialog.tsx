import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CollectionDetail, CreateCollectionRequest, UpdateCollectionRequest } from '@alexandria/shared';
import { createCollection, updateCollection } from '../../api/collections';
import { useToast } from '../../hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';

interface CollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** If provided, the dialog edits the given collection. Otherwise it creates a new one. */
  collection?: CollectionDetail;
  /** All existing collections — used to populate the parent selector. */
  allCollections: CollectionDetail[];
  /** Called after a successful create or update. */
  onSuccess?: (result: CollectionDetail) => void;
}

export function CollectionDialog({
  open,
  onOpenChange,
  collection,
  allCollections,
  onSuccess,
}: CollectionDialogProps) {
  const isEdit = !!collection;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState('');

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setName(collection?.name ?? '');
      setDescription(collection?.description ?? '');
      setParentId(collection?.parentCollectionId ?? '');
    }
  }, [open, collection]);

  const createMutation = useMutation({
    mutationFn: (data: CreateCollectionRequest) => createCollection(data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      toast({ title: 'Collection created' });
      onOpenChange(false);
      onSuccess?.(result);
    },
    onError: () => {
      toast({ title: 'Failed to create collection', variant: 'destructive' });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: UpdateCollectionRequest) =>
      updateCollection(collection!.id, data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      queryClient.invalidateQueries({ queryKey: ['collection', collection!.id] });
      toast({ title: 'Collection updated' });
      onOpenChange(false);
      onSuccess?.(result);
    },
    onError: () => {
      toast({ title: 'Failed to update collection', variant: 'destructive' });
    },
  });

  const isLoading = createMutation.isPending || updateMutation.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    if (isEdit) {
      updateMutation.mutate({
        name: name.trim(),
        description: description.trim() || null,
        parentCollectionId: parentId || null,
      });
    } else {
      createMutation.mutate({
        name: name.trim(),
        description: description.trim() || undefined,
        parentCollectionId: parentId || undefined,
      });
    }
  }

  // When editing, exclude the collection itself and its children from parent options
  const parentOptions = allCollections.filter((c) => {
    if (!isEdit) return true;
    if (c.id === collection!.id) return false;
    // Basic check: don't allow selecting a child as parent
    return c.parentCollectionId !== collection!.id;
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Collection' : 'New Collection'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="collection-name">Name</Label>
            <Input
              id="collection-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Collection name"
              required
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="collection-description">Description</Label>
            <Textarea
              id="collection-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              rows={3}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="collection-parent">Parent Collection</Label>
            <select
              id="collection-parent"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">None (top-level)</option>
              {parentOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading || !name.trim()}>
              {isLoading ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Collection'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
