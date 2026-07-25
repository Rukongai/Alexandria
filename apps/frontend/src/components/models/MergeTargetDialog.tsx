import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2, Package } from 'lucide-react';
import type { ModelCard, ModelDetail, ModelStatus } from '@alexandria/shared';
import { getModel, mergeModels } from '../../api/models';
import { useToast } from '../../hooks/use-toast';
import { formatFileSize } from '../../lib/format';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

/** Mirrors the `mergeModelsSchema` source cap in packages/shared. */
const MAX_SOURCE_MODELS = 100;

interface MergeTargetDialogProps {
  selectedIds: Set<string>;
  /** Models already loaded by the caller, used to name the selection without refetching. */
  models: ModelCard[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}

/** The subset of a model this dialog needs to render a row and validate a merge. */
type MergeCandidate = Pick<
  ModelCard,
  'id' | 'name' | 'fileCount' | 'totalSizeBytes' | 'status' | 'thumbnailUrl'
>;

/** Why a model cannot be merged, or null when it can. New statuses are ineligible by default. */
function ineligibleReason(status: ModelStatus): string | null {
  if (status === 'ready') return null;
  return status === 'processing' ? 'Processing' : 'Error';
}

function toCandidate(model: ModelCard | ModelDetail): MergeCandidate {
  return {
    id: model.id,
    name: model.name,
    fileCount: model.fileCount,
    totalSizeBytes: model.totalSizeBytes,
    status: model.status,
    thumbnailUrl: model.thumbnailUrl,
  };
}

/**
 * Picks which of the selected models survives a bulk merge.
 *
 * Every other ready selection is folded into the chosen target and deleted.
 * Models that are not ready cannot be merged by the API, so they are shown as
 * ineligible and left out of the request.
 */
export function MergeTargetDialog({
  selectedIds,
  models,
  open,
  onOpenChange,
  onDone,
}: MergeTargetDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [targetId, setTargetId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstOptionRef = useRef<HTMLInputElement>(null);

  // Selection survives filter and search changes, so a selected model is not
  // guaranteed to still be in the caller's loaded page. Fetch only the strays.
  const loaded = new Map(models.map((model) => [model.id, model]));
  const missingIds = [...selectedIds].filter((id) => !loaded.has(id));

  const {
    data: fetched,
    isLoading: isLoadingMissing,
    isError: strayFetchFailed,
  } = useQuery({
    queryKey: ['merge-selection', [...missingIds].sort()],
    queryFn: () => Promise.all(missingIds.map((id) => getModel(id))),
    enabled: open && missingIds.length > 0,
  });

  const candidates: MergeCandidate[] = [
    ...models.filter((model) => selectedIds.has(model.id)).map(toCandidate),
    ...(fetched ?? []).map(toCandidate),
  ];
  const mergeable = candidates.filter((candidate) => ineligibleReason(candidate.status) === null);
  const skippedCount = candidates.length - mergeable.length;
  const sourceCount = mergeable.length - 1;

  // A failed stray fetch would otherwise render a silently truncated selection,
  // so the merge is blocked rather than folding in only part of what was picked.
  const tooManySources = sourceCount > MAX_SOURCE_MODELS;
  const blockingMessage = strayFetchFailed
    ? `${missingIds.length} selected ${missingIds.length === 1 ? 'model' : 'models'} could not be loaded. Close this dialog and reselect before merging.`
    : mergeable.length < 2
      ? 'Merging needs at least two ready models.'
      : tooManySources
        ? `At most ${MAX_SOURCE_MODELS} models can be merged into one at a time. Deselect ${sourceCount - MAX_SOURCE_MODELS} to continue.`
        : null;
  const canMerge = blockingMessage === null;

  // Clear a stale choice so a reopened dialog never merges into a model the
  // user picked during an earlier, different selection.
  useEffect(() => {
    if (!open) setTargetId(null);
  }, [open]);

  // The shared dialog primitive does no focus management, so move focus in on
  // open the same way the collection picker in BulkActions does.
  useEffect(() => {
    if (!open || isLoadingMissing) return;
    if (firstOptionRef.current) firstOptionRef.current.focus();
    else dialogRef.current?.focus();
  }, [open, isLoadingMissing]);

  const mutation = useMutation({
    mutationFn: (target: string) =>
      mergeModels(
        target,
        mergeable.map((candidate) => candidate.id).filter((id) => id !== target),
      ),
    onSuccess: async (result) => {
      // Merged sources are gone: drop this dialog's own lookups instead of
      // refetching them, so a later selection cannot resurface deleted models.
      queryClient.removeQueries({ queryKey: ['merge-selection'] });
      queryClient.removeQueries({ queryKey: ['merge-candidates'] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['model'] }),
        queryClient.invalidateQueries({ queryKey: ['model-files'] }),
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['collections'] }),
        queryClient.invalidateQueries({ queryKey: ['collection'] }),
        queryClient.invalidateQueries({ queryKey: ['collection-models'] }),
        queryClient.invalidateQueries({ queryKey: ['field-values'] }),
        queryClient.invalidateQueries({ queryKey: ['search'] }),
        queryClient.invalidateQueries({ queryKey: ['smart-collection'] }),
        queryClient.invalidateQueries({ queryKey: ['smart-collections'] }),
        queryClient.invalidateQueries({ queryKey: ['smart-preview'] }),
      ]);
      const merged = result.mergedModelIds.length;
      toast({
        title: `Merged ${merged} model${merged === 1 ? '' : 's'}`,
        description: `${result.movedFileCount} file${result.movedFileCount === 1 ? '' : 's'} moved.`,
      });
      onOpenChange(false);
      onDone();
    },
    onError: (error) => {
      toast({
        title: 'Merge failed',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    },
  });

  let firstOptionAssigned = false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={dialogRef} tabIndex={-1} className="max-w-xl outline-none">
        <DialogHeader>
          <DialogTitle>Merge models</DialogTitle>
          <DialogDescription>
            Choose the model to keep. The other selected models are folded into it — their files,
            tags, collections, and metadata for fields the kept model has not already filled move
            over — and then deleted. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {isLoadingMissing && (
          <div
            className="flex h-24 items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading selected models…
          </div>
        )}

        {!isLoadingMissing && (
          <>
            {skippedCount > 0 && (
              <p
                id="merge-skipped-notice"
                role="status"
                className="flex items-start gap-1.5 text-xs text-muted-foreground"
              >
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {skippedCount} selected {skippedCount === 1 ? 'model is' : 'models are'} not ready
                and will be skipped.
              </p>
            )}

            <fieldset className="max-h-72 overflow-y-auto rounded-md border">
              <legend className="sr-only">Model to keep</legend>
              {candidates.map((candidate) => {
                const blockedBy = ineligibleReason(candidate.status);
                const isMergeable = blockedBy === null;
                const isFirstOption = isMergeable && !firstOptionAssigned;
                if (isFirstOption) firstOptionAssigned = true;
                return (
                  <label
                    key={candidate.id}
                    className={
                      isMergeable
                        ? 'flex cursor-pointer items-center gap-3 border-b px-3 py-2 last:border-b-0 hover:bg-accent'
                        : 'flex items-center gap-3 border-b px-3 py-2 last:border-b-0 opacity-50'
                    }
                  >
                    <input
                      ref={isFirstOption ? firstOptionRef : undefined}
                      type="radio"
                      name="merge-target"
                      checked={targetId === candidate.id}
                      onChange={() => setTargetId(candidate.id)}
                      disabled={!isMergeable || mutation.isPending}
                      className="h-4 w-4 border border-input bg-background accent-primary"
                    />
                    {candidate.thumbnailUrl ? (
                      <img
                        src={`/api${candidate.thumbnailUrl}`}
                        alt=""
                        className="h-10 w-10 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted">
                        <Package className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{candidate.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {candidate.fileCount} {candidate.fileCount === 1 ? 'file' : 'files'} ·{' '}
                        {formatFileSize(candidate.totalSizeBytes)}
                        {blockedBy && ` · ${blockedBy}`}
                      </div>
                    </div>
                  </label>
                );
              })}
            </fieldset>

            {blockingMessage && (
              <p id="merge-blocked-reason" role="status" className="text-xs text-destructive">
                {blockingMessage}
              </p>
            )}
          </>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => targetId && mutation.mutate(targetId)}
            disabled={!targetId || !canMerge || mutation.isPending}
            aria-describedby={
              [
                blockingMessage ? 'merge-blocked-reason' : null,
                skippedCount > 0 ? 'merge-skipped-notice' : null,
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
            className="gap-2"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {targetId && canMerge
              ? `Merge ${sourceCount} model${sourceCount === 1 ? '' : 's'} in`
              : 'Merge'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
