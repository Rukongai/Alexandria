import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, FolderInput, FolderPlus, Loader2, Tag, Trash2, X } from 'lucide-react';
import type { CollectionDetail } from '@alexandria/shared';
import { bulkDelete, bulkCollection, bulkMetadata } from '../../api/bulk';
import { addModelsToCollection, getCollections } from '../../api/collections';
import { getFieldValues } from '../../api/metadata';
import { useToast } from '../../hooks/use-toast';
import { Button } from '../ui/button';
import { AlertDialog } from '../ui/alert-dialog';
import { TagAutocomplete } from '../metadata/tag-autocomplete';

interface BulkActionsProps {
  selectedIds: Set<string>;
  onClear: () => void;
  onComplete: () => void;
}

interface CollectionPickerProps {
  selectedIds: string[];
  action: 'add' | 'move';
  id: string;
  onClose: () => void;
  onDone: () => void;
}

function CollectionPicker({ selectedIds, action, id, onClose, onDone }: CollectionPickerProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const panelRef = useRef<HTMLDivElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['collections'],
    queryFn: () => getCollections().then((response) => response.data),
  });

  const collections: CollectionDetail[] = data ?? [];
  const isAdd = action === 'add';

  useEffect(() => {
    if (!isLoading && collections.length > 0) firstOptionRef.current?.focus();
    else panelRef.current?.focus();
  }, [collections.length, isLoading]);

  const collectionMutation = useMutation({
    mutationFn: (collectionId: string) =>
      isAdd
        ? addModelsToCollection(collectionId, selectedIds)
        : bulkCollection({ modelIds: selectedIds, action: 'move', collectionId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      queryClient.invalidateQueries({ queryKey: ['collection'] });
      queryClient.invalidateQueries({ queryKey: ['collection-models'] });
      queryClient.invalidateQueries({ queryKey: ['model'] });
      queryClient.invalidateQueries({ queryKey: ['models'] });
      queryClient.invalidateQueries({ queryKey: ['search'] });
      queryClient.invalidateQueries({ queryKey: ['smart-collection'] });
      queryClient.invalidateQueries({ queryKey: ['smart-collections'] });
      queryClient.invalidateQueries({ queryKey: ['smart-preview'] });
      toast({
        title: isAdd
          ? `Added ${selectedIds.length} model${selectedIds.length === 1 ? '' : 's'} to collection`
          : `Moved ${selectedIds.length} model${selectedIds.length === 1 ? '' : 's'}`,
      });
      onDone();
    },
    onError: () => {
      toast({
        title: isAdd ? 'Failed to add models to collection' : 'Failed to move models',
        variant: 'destructive',
      });
    },
  });

  return (
    <div
      ref={panelRef}
      id={id}
      role="dialog"
      aria-label={isAdd ? 'Add models to collection' : 'Move models to collection'}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
      className="bg-popover text-popover-foreground border rounded-lg shadow-lg p-4 w-64 max-w-[calc(100vw-2rem)] flex flex-col gap-3 outline-none"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          {isAdd ? 'Add to collection' : 'Move to collection'}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          aria-label={`Close ${isAdd ? 'add' : 'move'} collection picker`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        {isAdd
          ? 'Existing collection memberships will be kept.'
          : 'Existing collection memberships will be replaced.'}
      </p>

      {isLoading && (
        <div className="flex h-20 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading collections…
        </div>
      )}
      {!isLoading && isError && (
        <div className="flex flex-col items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2">
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
            Collections could not be loaded.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      )}
      {!isLoading && !isError && collections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No collections found.</p>
      ) : null}
      {!isLoading && !isError && collections.length > 0 && (
        <ul className="flex flex-col gap-1 max-h-48 overflow-y-auto">
          {collections.map((col) => (
            <li key={col.id}>
              <button
                ref={col === collections[0] ? firstOptionRef : undefined}
                type="button"
                className="w-full text-left rounded-md px-3 py-1.5 text-sm hover:bg-accent transition-colors"
                onClick={() => collectionMutation.mutate(col.id)}
                disabled={collectionMutation.isPending}
                aria-label={`${isAdd ? 'Add to' : 'Move to'} ${col.name}`}
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

interface TagPickerProps {
  selectedIds: string[];
  onClose: () => void;
  onDone: () => void;
}

function TagPicker({ selectedIds, onClose, onDone }: TagPickerProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  const { data } = useQuery({
    queryKey: ['field-values', 'tags'],
    queryFn: () => getFieldValues('tags'),
  });

  const existingTags = data ?? [];
  const selectedKeys = new Set(selectedTags.map((tag) => tag.toLowerCase()));
  const trimmedInput = input.trim();
  const normalizedInput = trimmedInput.toLowerCase();
  const tagsToApply =
    trimmedInput && !selectedKeys.has(normalizedInput)
      ? [...selectedTags, trimmedInput]
      : selectedTags;
  const tagMutation = useMutation({
    mutationFn: (tags: string[]) =>
      bulkMetadata({
        modelIds: selectedIds,
        operations: [{ fieldSlug: 'tags', action: 'add', value: tags }],
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] });
      queryClient.invalidateQueries({ queryKey: ['field-values', 'tags'] });
      toast({
        title: `Tagged ${selectedIds.length} model${selectedIds.length === 1 ? '' : 's'}`,
      });
      onDone();
    },
    onError: () => {
      toast({ title: 'Failed to tag models', variant: 'destructive' });
    },
  });

  return (
    <div className="bg-popover text-popover-foreground border rounded-lg shadow-lg p-4 w-72 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Add tags</span>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Close tag picker"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="text-xs text-muted-foreground">Existing tags will be kept.</p>

      <TagAutocomplete
        value={selectedTags}
        onChange={setSelectedTags}
        inputValue={input}
        onInputChange={setInput}
        suggestions={existingTags}
        placeholder="Add or create tags"
        inputAriaLabel="Tag name"
        autoFocus
      />

      <Button
        size="sm"
        onClick={() => tagMutation.mutate(tagsToApply)}
        disabled={tagsToApply.length === 0 || tagMutation.isPending}
      >
        {tagsToApply.length === 0
          ? 'Add tags'
          : `Add ${tagsToApply.length} tag${tagsToApply.length === 1 ? '' : 's'}`}
      </Button>
    </div>
  );
}

// --- Main BulkActions bar ---
export function BulkActions({ selectedIds, onClear, onComplete }: BulkActionsProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const count = selectedIds.size;
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const moveTriggerRef = useRef<HTMLButtonElement>(null);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [activePicker, setActivePicker] = useState<'add' | 'move' | 'tag' | null>(null);

  function closeCollectionPicker(action: 'add' | 'move') {
    setActivePicker(null);
    requestAnimationFrame(() => {
      (action === 'add' ? addTriggerRef : moveTriggerRef).current?.focus();
    });
  }

  const deleteMutation = useMutation({
    mutationFn: () => bulkDelete({ modelIds: Array.from(selectedIds) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] });
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      toast({ title: `${count} model${count !== 1 ? 's' : ''} deleted` });
      setShowDeleteConfirm(false);
      onComplete();
    },
    onError: () => {
      toast({ title: 'Failed to delete models', variant: 'destructive' });
    },
  });

  if (count === 0) return null;

  return (
    <>
      <div
        className="absolute bottom-6 left-1/2 z-40 flex w-max max-w-[calc(100%_-_2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-x-1 gap-y-1 rounded-lg bg-foreground px-3 py-2 text-background shadow-xl sm:gap-x-2 sm:px-4 sm:py-3"
        role="toolbar"
        aria-label="Bulk model actions"
      >
        <span className="whitespace-nowrap px-1 text-sm font-medium tabular-nums">
          {count} {count === 1 ? 'model' : 'models'} selected
        </span>

        <div className="hidden h-4 w-px bg-background/20 sm:block" />

        {/* Add-to-collection button */}
        <div>
          <Button
            ref={addTriggerRef}
            size="sm"
            variant="ghost"
            className="text-background hover:text-background hover:bg-black/10 dark:hover:bg-white/10"
            onClick={() => {
              setActivePicker((current) => (current === 'add' ? null : 'add'));
            }}
            aria-expanded={activePicker === 'add'}
            aria-controls="bulk-add-collection-picker"
            aria-haspopup="dialog"
            aria-label="Add to collection"
            title="Add to collection"
          >
            <FolderPlus className="h-4 w-4 mr-1.5" />
            Add
          </Button>
        </div>

        {/* Move button */}
        <div className="relative">
          <Button
            ref={moveTriggerRef}
            size="sm"
            variant="ghost"
            className="text-background hover:text-background hover:bg-black/10 dark:hover:bg-white/10"
            onClick={() => {
              setActivePicker((current) => (current === 'move' ? null : 'move'));
            }}
            aria-expanded={activePicker === 'move'}
            aria-controls="bulk-move-collection-picker"
            aria-haspopup="dialog"
          >
            <FolderInput className="h-4 w-4 mr-1.5" />
            Move
          </Button>
        </div>

        {/* Tag button */}
        <div className="relative">
          <Button
            size="sm"
            variant="ghost"
            className="text-background hover:text-background hover:bg-black/10 dark:hover:bg-white/10"
            onClick={() => setActivePicker((current) => (current === 'tag' ? null : 'tag'))}
          >
            <Tag className="h-4 w-4 mr-1.5" />
            Tag
          </Button>
          {activePicker === 'tag' && (
            <div className="absolute bottom-full left-0 mb-2">
              <TagPicker
                selectedIds={Array.from(selectedIds)}
                onClose={() => setActivePicker(null)}
                onDone={onComplete}
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

        <div className="hidden h-4 w-px bg-background/20 sm:block" />

        {/* Clear selection */}
        <button
          type="button"
          className="text-background/60 hover:text-background transition-colors"
          onClick={onClear}
          aria-label="Clear selection"
        >
          <X className="h-4 w-4" />
        </button>

        {(activePicker === 'add' || activePicker === 'move') && (
          <div className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2">
            <CollectionPicker
              key={activePicker}
              selectedIds={Array.from(selectedIds)}
              action={activePicker}
              id={`bulk-${activePicker}-collection-picker`}
              onClose={() => closeCollectionPicker(activePicker)}
              onDone={onComplete}
            />
          </div>
        )}
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
