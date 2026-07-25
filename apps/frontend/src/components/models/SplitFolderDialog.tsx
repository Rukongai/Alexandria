import * as React from 'react';
import type { MetadataValue } from '@alexandria/shared';
import { Loader2, Scissors } from 'lucide-react';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

interface SplitFolderDialogProps {
  open: boolean;
  folderPath: string;
  initialName: string;
  metadata: MetadataValue[];
  onOpenChange: (open: boolean) => void;
  onConfirm: (name: string, metadataFieldSlugs: string[]) => Promise<void>;
}

function isPopulatedMetadata(field: MetadataValue): boolean {
  return Array.isArray(field.value)
    ? field.value.length > 0
    : field.value.trim().length > 0;
}

export function SplitFolderDialog({
  open,
  folderPath,
  initialName,
  metadata,
  onOpenChange,
  onConfirm,
}: SplitFolderDialogProps) {
  const [name, setName] = React.useState(initialName);
  const [selectedMetadataSlugs, setSelectedMetadataSlugs] = React.useState<Set<string>>(
    new Set(),
  );
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const trimmedName = name.trim();
  const populatedMetadata = React.useMemo(
    () => metadata.filter(isPopulatedMetadata),
    [metadata],
  );

  React.useEffect(() => {
    if (open) {
      setName(initialName);
      setSelectedMetadataSlugs(new Set());
    }
  }, [open, initialName, folderPath]);

  function setMetadataSelected(fieldSlug: string, selected: boolean) {
    setSelectedMetadataSlugs((current) => {
      const next = new Set(current);
      if (selected) next.add(fieldSlug);
      else next.delete(fieldSlug);
      return next;
    });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedName || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onConfirm(trimmedName, [...selectedMetadataSlugs]);
      onOpenChange(false);
    } catch {
      // The mutation owner reports the error. Keep the dialog open for retry.
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSubmitting) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="max-w-md"
        aria-busy={isSubmitting}
        showCloseButton={!isSubmitting}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors className="h-4 w-4 text-primary" aria-hidden="true" />
            Split Folder into New Model
          </DialogTitle>
          <DialogDescription>
            Everything in <span className="font-medium text-foreground">{folderPath}</span> will
            move into a new model and become its root contents.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="split-model-name">New model name</Label>
            <Input
              id="split-model-name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              disabled={isSubmitting}
              maxLength={255}
              autoFocus
            />
          </div>

          {populatedMetadata.length > 0 && (
            <fieldset className="flex flex-col gap-2" disabled={isSubmitting}>
              <legend className="sr-only">Copy metadata</legend>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-foreground">Copy metadata</span>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={selectedMetadataSlugs.size === populatedMetadata.length}
                    onClick={() =>
                      setSelectedMetadataSlugs(
                        new Set(populatedMetadata.map((field) => field.fieldSlug)),
                      )
                    }
                  >
                    Select all
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={selectedMetadataSlugs.size === 0}
                    onClick={() => setSelectedMetadataSlugs(new Set())}
                  >
                    Clear all
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Choose which details to carry over to the new model.
              </p>
              <div className="max-h-52 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                {populatedMetadata.map((field) => (
                  <div
                    key={field.fieldSlug}
                    className="rounded-md px-2 py-1.5 hover:bg-muted/50"
                  >
                    <Checkbox
                      id={`split-metadata-${field.fieldSlug}`}
                      aria-describedby={`split-metadata-value-${field.fieldSlug}`}
                      checked={selectedMetadataSlugs.has(field.fieldSlug)}
                      onChange={(event) =>
                        setMetadataSelected(field.fieldSlug, event.currentTarget.checked)
                      }
                      label={field.fieldName}
                    />
                    <p
                      id={`split-metadata-value-${field.fieldSlug}`}
                      className="ml-6 mt-1 truncate text-xs text-muted-foreground"
                      title={field.displayValue}
                    >
                      {field.displayValue}
                    </p>
                  </div>
                ))}
              </div>
            </fieldset>
          )}

          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            Collection memberships stay with the current model and are never copied to the new
            model.
          </p>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmedName || isSubmitting} className="gap-2">
              {isSubmitting && (
                <Loader2
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              )}
              {isSubmitting ? 'Splitting…' : 'Create Model'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
