import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, FolderPlus, Tag, X } from 'lucide-react';
import type { CollectionDetail } from '@alexandria/shared';
import { bulkDelete, bulkCollection, bulkMetadata } from '../../api/bulk';
import { getCollections } from '../../api/collections';
import { getFields } from '../../api/metadata';
import { useToast } from '../../hooks/use-toast';
import { Button } from '../ui/button';
import { AlertDialog } from '../ui/alert-dialog';
import { Input } from '../ui/input';

interface BulkActionsProps {
  selectedIds: Set<string>;
  onClear: () => void;
  onDeleted: () => void;
}

// --- Tag popover (simple inline panel) ---
interface TagPopoverProps {
  selectedIds: string[];
  onClose: () => void;
  onDone: () => void;
}

function TagPanel({ selectedIds, onClose, onDone }: TagPopoverProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [tagValue, setTagValue] = useState('');

  const addMutation = useMutation({
    mutationFn: () =>
      bulkMetadata({
        modelIds: selectedIds,
        operations: [{ fieldSlug: 'tags', action: 'set', value: tagValue.trim() }],
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] });
      toast({ title: `Tag "${tagValue.trim()}" added to ${selectedIds.length} models` });
      onDone();
    },
    onError: () => {
      toast({ title: 'Failed to apply tags', variant: 'destructive' });
    },
  });

  return (
    <div className="bg-popover text-popover-foreground border rounded-lg shadow-lg p-4 w-72 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Add Tag</span>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex gap-2">
        <Input
          value={tagValue}
          onChange={(e) => setTagValue(e.target.value)}
          placeholder="Tag name"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && tagValue.trim()) addMutation.mutate();
          }}
          autoFocus
        />
        <Button
          size="sm"
          onClick={() => addMutation.mutate()}
          disabled={!tagValue.trim() || addMutation.isPending}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

// --- Collection picker ---
interface CollectionPickerProps {
  selectedIds: string[];
  onClose: () => void;
  onDone: () => void;
}

function CollectionPicker({ selectedIds, onClose, onDone }: CollectionPickerProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['collections'],
    queryFn: () => getCollections(),
    select: (res) => res.data,
  });

  const collections: CollectionDetail[] = data ?? [];

  const addMutation = useMutation({
    mutationFn: (collectionId: string) =>
      bulkCollection({ modelIds: selectedIds, action: 'add', collectionId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      queryClient.invalidateQueries({ queryKey: ['models'] });
      toast({ title: `Added ${selectedIds.length} models to collection` });
      onDone();
    },
    onError: () => {
      toast({ title: 'Failed to add to collection', variant: 'destructive' });
    },
  });

  return (
    <div className="bg-popover text-popover-foreground border rounded-lg shadow-lg p-4 w-64 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Add to Collection</span>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      {collections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No collections found.</p>
      ) : (
        <ul className="flex flex-col gap-1 max-h-48 overflow-y-auto">
          {collections.map((col) => (
            <li key={col.id}>
              <button
                type="button"
                className="w-full text-left rounded-md px-3 py-1.5 text-sm hover:bg-accent transition-colors"
                onClick={() => addMutation.mutate(col.id)}
                disabled={addMutation.isPending}
              >
                {col.name}
                <span className="text-muted-foreground ml-1 text-xs">({col.modelCount})</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Main BulkActions bar ---
export function BulkActions({ selectedIds, onClear, onDeleted }: BulkActionsProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const count = selectedIds.size;

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [activePanel, setActivePanel] = useState<'tag' | 'collection' | null>(null);

  const deleteMutation = useMutation({
    mutationFn: () => bulkDelete({ modelIds: Array.from(selectedIds) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] });
      toast({ title: `${count} model${count !== 1 ? 's' : ''} deleted` });
      setShowDeleteConfirm(false);
      onDeleted();
    },
    onError: () => {
      toast({ title: 'Failed to delete models', variant: 'destructive' });
    },
  });

  if (count === 0) return null;

  return (
    <>
      {/* Floating bar */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-foreground text-background rounded-full px-5 py-3 shadow-xl">
        <span className="text-sm font-medium tabular-nums">
          {count} {count === 1 ? 'model' : 'models'} selected
        </span>

        <div className="h-4 w-px bg-background/20" />

        {/* Tag button */}
        <div className="relative">
          <Button
            size="sm"
            variant="ghost"
            className="text-background hover:text-background hover:bg-black/10 dark:hover:bg-white/10"
            onClick={() => setActivePanel(activePanel === 'tag' ? null : 'tag')}
          >
            <Tag className="h-4 w-4 mr-1.5" />
            Tag
          </Button>
          {activePanel === 'tag' && (
            <div className="absolute bottom-full left-0 mb-2">
              <TagPanel
                selectedIds={Array.from(selectedIds)}
                onClose={() => setActivePanel(null)}
                onDone={() => setActivePanel(null)}
              />
            </div>
          )}
        </div>

        {/* Collection button */}
        <div className="relative">
          <Button
            size="sm"
            variant="ghost"
            className="text-background hover:text-background hover:bg-black/10 dark:hover:bg-white/10"
            onClick={() => setActivePanel(activePanel === 'collection' ? null : 'collection')}
          >
            <FolderPlus className="h-4 w-4 mr-1.5" />
            Collect
          </Button>
          {activePanel === 'collection' && (
            <div className="absolute bottom-full left-0 mb-2">
              <CollectionPicker
                selectedIds={Array.from(selectedIds)}
                onClose={() => setActivePanel(null)}
                onDone={() => setActivePanel(null)}
              />
            </div>
          )}
        </div>

        {/* Delete button */}
        <Button
          size="sm"
          variant="ghost"
          className="text-red-400 hover:text-red-300 hover:bg-white/10"
          onClick={() => setShowDeleteConfirm(true)}
        >
          <Trash2 className="h-4 w-4 mr-1.5" />
          Delete
        </Button>

        <div className="h-4 w-px bg-background/20" />

        {/* Clear selection */}
        <button
          type="button"
          className="text-background/60 hover:text-background transition-colors"
          onClick={onClear}
          aria-label="Clear selection"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Delete confirmation */}
      <AlertDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title={`Delete ${count} ${count === 1 ? 'model' : 'models'}?`}
        description="This action cannot be undone. All files, metadata, and thumbnails for the selected models will be permanently deleted."
        confirmLabel={`Delete ${count} ${count === 1 ? 'model' : 'models'}`}
        destructive
        isLoading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
      />
    </>
  );
}
