import * as React from 'react';
import type { LibrarySummary } from '@alexandria/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Select } from '../ui/select';

interface MoveModelDialogProps {
  modelName: string;
  libraries: LibrarySummary[];
  currentLibraryId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (targetLibraryId: string) => Promise<void>;
}

export function MoveModelDialog({
  modelName,
  libraries,
  currentLibraryId,
  open,
  onOpenChange,
  onConfirm,
}: MoveModelDialogProps) {
  const destinations = React.useMemo(
    () => libraries.filter((library) => library.id !== currentLibraryId),
    [libraries, currentLibraryId],
  );
  const [targetLibraryId, setTargetLibraryId] = React.useState('');
  const [isPending, setIsPending] = React.useState(false);

  React.useEffect(() => {
    if (open) setTargetLibraryId(destinations[0]?.id ?? '');
  }, [open, destinations]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!targetLibraryId || isPending) return;

    setIsPending(true);
    try {
      await onConfirm(targetLibraryId);
      onOpenChange(false);
    } finally {
      setIsPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Move model</DialogTitle>
            <DialogDescription>
              Move “{modelName}” to another library. Its current collection memberships will be
              removed because collections belong to their library.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="move-model-destination">Destination library</Label>
            <Select
              id="move-model-destination"
              value={targetLibraryId}
              onChange={(event) => setTargetLibraryId(event.target.value)}
              disabled={isPending || destinations.length === 0}
            >
              {destinations.map((library) => (
                <option key={library.id} value={library.id}>
                  {library.name}
                </option>
              ))}
            </Select>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!targetLibraryId || isPending}>
              {isPending ? 'Moving…' : 'Move model'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
