import { useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import type { ConsolidateDuplicateModelsPreview, DuplicateModel } from '@alexandria/shared';
import { consolidateDuplicateModels, previewDuplicateModelConsolidation } from '../../api/tools';
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

interface ConsolidateDuplicateDialogProps {
  source: DuplicateModel | null;
  candidates: DuplicateModel[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (result: ConsolidateDuplicateModelsPreview) => void;
}

/**
 * Previews an exact-duplicate consolidation before it can remove a model.
 * The server remains authoritative: it repeats the duplicate check when the
 * user confirms, so a scan result cannot be used after it has become stale.
 */
export function ConsolidateDuplicateDialog({
  source,
  candidates,
  open,
  onOpenChange,
  onComplete,
}: ConsolidateDuplicateDialogProps) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ConsolidateDuplicateModelsPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const targets = source ? candidates.filter((candidate) => candidate.id !== source.id) : [];

  useEffect(() => {
    if (!open || !source) {
      setTargetId(null);
      setPreview(null);
      setPreviewError(null);
      return;
    }
    setTargetId(targets[0]?.id ?? null);
    setPreview(null);
    setPreviewError(null);
  }, [open, source?.id]); // The source identifies a new per-model operation.

  const loadPreview = async () => {
    if (!source || !targetId) return;
    setPreviewError(null);
    setIsPreviewing(true);
    try {
      setPreview(await previewDuplicateModelConsolidation(source.id, targetId));
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Could not prepare this consolidation.');
    } finally {
      setIsPreviewing(false);
    }
  };

  const confirm = async () => {
    if (!source || !targetId) return;
    setPreviewError(null);
    setIsConfirming(true);
    try {
      const result = await consolidateDuplicateModels(source.id, targetId);
      onComplete(result);
      onOpenChange(false);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Consolidation failed. No changes were applied.');
    } finally {
      setIsConfirming(false);
    }
  };

  const pending = isPreviewing || isConfirming;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!pending || nextOpen) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-2xl" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Consolidate duplicate model</DialogTitle>
          <DialogDescription>
            {source
              ? `Choose which identical model to keep. ${source.name} and its duplicate files will be removed only after you confirm the complete preview below.`
              : 'Choose a duplicate model to consolidate.'}
          </DialogDescription>
        </DialogHeader>

        {source && (
          <fieldset className="rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium text-foreground">Keep this model</legend>
            <div className="mt-1 flex flex-col gap-2">
              {targets.map((target) => (
                <label key={target.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted">
                  <input
                    type="radio"
                    name="consolidate-target"
                    checked={targetId === target.id}
                    onChange={() => {
                      setTargetId(target.id);
                      setPreview(null);
                      setPreviewError(null);
                    }}
                    disabled={pending}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="text-sm font-medium text-foreground">{target.name}</span>
                  {target.id === targets[0]?.id && (
                    <span className="text-xs text-muted-foreground">Oldest copy</span>
                  )}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {!preview && !previewError && (
          <p className="text-sm text-muted-foreground">
            First review the exact files, metadata, tags, and collection memberships that this action will handle.
          </p>
        )}

        {preview && <ConsolidationPreview preview={preview} />}

        {previewError && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{previewError}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          {preview ? (
            <Button type="button" variant="destructive" onClick={() => void confirm()} disabled={pending}>
              {isConfirming && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Consolidate and remove duplicate
            </Button>
          ) : (
            <Button type="button" onClick={() => void loadPreview()} disabled={!targetId || pending}>
              {isPreviewing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isPreviewing ? 'Preparing preview…' : 'Review changes'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConsolidationPreview({ preview }: { preview: ConsolidateDuplicateModelsPreview }) {
  return (
    <div className="flex max-h-[48vh] flex-col gap-4 overflow-y-auto rounded-lg border bg-muted/20 p-4">
      <div className="flex items-start gap-2 text-sm">
        <Trash2 className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <p>
          <strong>{preview.sourceModel.name}</strong> will be deleted. <strong>{preview.targetModel.name}</strong> will remain.
          {' '}{preview.deletedFileCount} duplicate {preview.deletedFileCount === 1 ? 'file' : 'files'} ({formatFileSize(preview.reclaimableBytes)}) will be removed from storage.
        </p>
      </div>

      <div>
        <h3 className="text-sm font-medium text-foreground">Files to remove</h3>
        <ul className="mt-2 divide-y rounded-md border bg-background text-sm">
          {preview.removedFiles.map((file) => (
            <li key={file.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={file.relativePath}>{file.relativePath}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatFileSize(file.sizeBytes)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-sm font-medium text-foreground">Generated thumbnails to remove</h3>
        <ActionList
          items={preview.removedThumbnails.map((thumbnail) =>
            `${thumbnail.sourceFilename} — ${thumbnail.width} × ${thumbnail.height} ${thumbnail.format.toUpperCase()}`,
          )}
          empty="No generated thumbnails will be removed."
        />
      </div>

      <div>
        <h3 className="text-sm font-medium text-foreground">Metadata copied to the kept model</h3>
        <ActionList
          items={preview.copiedMetadata.map((metadata) => `${metadata.fieldName}: ${metadata.value}`)}
          empty="No metadata fields need to be copied."
        />
      </div>

      <div>
        <h3 className="text-sm font-medium text-foreground">Collections added to the kept model</h3>
        <ActionList
          items={preview.addedCollections.map((collection) => collection.name)}
          empty="No collection memberships need to be added."
        />
      </div>

      <div>
        <h3 className="text-sm font-medium text-foreground">Tags added to the kept model</h3>
        <ActionList
          items={preview.addedTags.map((tag) => tag.name)}
          empty="No tags need to be added."
        />
      </div>
      <p className="text-xs text-muted-foreground">This cannot be undone.</p>
    </div>
  );
}

function ActionList({ items, empty }: { items: string[]; empty: string }) {
  return (
    <ul className="mt-2 divide-y rounded-md border bg-background text-sm">
      {items.length > 0 ? items.map((item) => (
        <li key={item} className="px-3 py-2 text-muted-foreground">{item}</li>
      )) : (
        <li className="px-3 py-2 text-muted-foreground">{empty}</li>
      )}
    </ul>
  );
}
