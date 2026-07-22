import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, FolderInput, Tag, X } from 'lucide-react';
import type { CollectionDetail, MetadataFieldValue } from '@alexandria/shared';
import { bulkDelete, bulkCollection, bulkMetadata } from '../../api/bulk';
import { getCollections } from '../../api/collections';
import { getFieldValues } from '../../api/metadata';
import { useToast } from '../../hooks/use-toast';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { AlertDialog } from '../ui/alert-dialog';

interface BulkActionsProps {
  selectedIds: Set<string>;
  onClear: () => void;
  onComplete: () => void;
}

interface MovePickerProps {
  selectedIds: string[];
  onClose: () => void;
  onDone: () => void;
}

function MovePicker({ selectedIds, onClose, onDone }: MovePickerProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['collections'],
    queryFn: () => getCollections().then((response) => response.data),
  });

  const collections: CollectionDetail[] = data ?? [];

  const moveMutation = useMutation({
    mutationFn: (collectionId: string) =>
      bulkCollection({ modelIds: selectedIds, action: 'move', collectionId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      queryClient.invalidateQueries({ queryKey: ['models'] });
      toast({ title: `Moved ${selectedIds.length} model${selectedIds.length === 1 ? '' : 's'}` });
      onDone();
    },
    onError: () => {
      toast({ title: 'Failed to move models', variant: 'destructive' });
    },
  });

  return (
    <div className="bg-popover text-popover-foreground border rounded-lg shadow-lg p-4 w-64 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Move to collection</span>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close collection picker">
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Existing collection memberships will be replaced.
      </p>
      {collections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No collections found.</p>
      ) : (
        <ul className="flex flex-col gap-1 max-h-48 overflow-y-auto">
          {collections.map((col) => (
            <li key={col.id}>
              <button
                type="button"
                className="w-full text-left rounded-md px-3 py-1.5 text-sm hover:bg-accent transition-colors"
                onClick={() => moveMutation.mutate(col.id)}
                disabled={moveMutation.isPending}
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

  const existingTags: MetadataFieldValue[] = data ?? [];
  const selectedKeys = new Set(selectedTags.map((tag) => tag.toLowerCase()));
  const trimmedInput = input.trim();
  const normalizedInput = trimmedInput.toLowerCase();
  const tagsToApply =
    trimmedInput && !selectedKeys.has(normalizedInput)
      ? [...selectedTags, trimmedInput]
      : selectedTags;
  const suggestions = existingTags
    .filter((tag) => !selectedKeys.has(tag.value.toLowerCase()))
    .filter((tag) => !normalizedInput || tag.value.toLowerCase().includes(normalizedInput))
    .slice(0, 6);

  const addTag = (rawTag: string) => {
    const tag = rawTag.trim();
    if (!tag || selectedKeys.has(tag.toLowerCase())) return;
    setSelectedTags((current) => [...current, tag]);
    setInput('');
  };

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

      {selectedTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedTags.map((tag) => (
            <span
              key={tag}
              className="inline-flex h-6 items-center gap-1 rounded-md bg-accent px-2 text-xs"
            >
              {tag}
              <button
                type="button"
                onClick={() =>
                  setSelectedTags((current) => current.filter((item) => item !== tag))
                }
                aria-label={`Remove tag ${tag}`}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <Input
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            addTag(input);
          }
        }}
        placeholder="Add or create tags"
        aria-label="Tag name"
        autoFocus
      />

      {suggestions.length > 0 && (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {suggestions.map((tag) => (
            <li key={tag.value}>
              <button
                type="button"
                onClick={() => addTag(tag.value)}
                className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent"
              >
                <span className="truncate">{tag.value}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{tag.modelCount}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

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

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showMovePicker, setShowMovePicker] = useState(false);
  const [showTagPicker, setShowTagPicker] = useState(false);

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
        className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-foreground text-background rounded-lg px-5 py-3 shadow-xl"
        role="toolbar"
        aria-label="Bulk model actions"
      >
        <span className="text-sm font-medium tabular-nums">
          {count} {count === 1 ? 'model' : 'models'} selected
        </span>

        <div className="h-4 w-px bg-background/20" />

        {/* Move button */}
        <div className="relative">
          <Button
            size="sm"
            variant="ghost"
            className="text-background hover:text-background hover:bg-black/10 dark:hover:bg-white/10"
            onClick={() => {
              setShowTagPicker(false);
              setShowMovePicker((open) => !open);
            }}
          >
            <FolderInput className="h-4 w-4 mr-1.5" />
            Move
          </Button>
          {showMovePicker && (
            <div className="absolute bottom-full left-0 mb-2">
              <MovePicker
                selectedIds={Array.from(selectedIds)}
                onClose={() => setShowMovePicker(false)}
                onDone={onComplete}
              />
            </div>
          )}
        </div>

        {/* Tag button */}
        <div className="relative">
          <Button
            size="sm"
            variant="ghost"
            className="text-background hover:text-background hover:bg-black/10 dark:hover:bg-white/10"
            onClick={() => {
              setShowMovePicker(false);
              setShowTagPicker((open) => !open);
            }}
          >
            <Tag className="h-4 w-4 mr-1.5" />
            Tag
          </Button>
          {showTagPicker && (
            <div className="absolute bottom-full left-0 mb-2">
              <TagPicker
                selectedIds={Array.from(selectedIds)}
                onClose={() => setShowTagPicker(false)}
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
