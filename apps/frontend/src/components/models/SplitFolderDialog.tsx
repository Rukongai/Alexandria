import * as React from 'react';
import { Loader2, Scissors } from 'lucide-react';
import { Button } from '../ui/button';
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
  onOpenChange: (open: boolean) => void;
  onConfirm: (name: string) => Promise<void>;
}

export function SplitFolderDialog({
  open,
  folderPath,
  initialName,
  onOpenChange,
  onConfirm,
}: SplitFolderDialogProps) {
  const [name, setName] = React.useState(initialName);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const trimmedName = name.trim();

  React.useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName, folderPath]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedName || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onConfirm(trimmedName);
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

          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            Metadata and collection memberships stay with the current model; they are not copied
            to the new model.
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
