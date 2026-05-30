import { useEffect, useState } from 'react';
import type { LibrarySummary, LibraryColor } from '@alexandria/shared';
import { useToast } from '../../hooks/use-toast';
import { useLibraries } from '../../hooks/use-libraries';
import { LIBRARY_COLORS, libraryGradient } from '../../lib/library-color';
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
import { cn } from '../../lib/utils';

interface LibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** If provided, the dialog edits the given library. Otherwise it creates one. */
  library?: LibrarySummary;
  /** Called with the created/updated library on success. */
  onSuccess?: (result: LibrarySummary) => void;
}

export function LibraryDialog({ open, onOpenChange, library, onSuccess }: LibraryDialogProps) {
  const isEdit = !!library;
  const { toast } = useToast();
  const { createLibrary, updateLibrary } = useLibraries();

  const [name, setName] = useState('');
  const [color, setColor] = useState<LibraryColor>('amber');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(library?.name ?? '');
      setColor((library?.color as LibraryColor) ?? 'amber');
    }
  }, [open, library]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setIsSaving(true);
    try {
      const result = isEdit
        ? await updateLibrary(library!.id, { name: trimmed, color })
        : await createLibrary({ name: trimmed, color });
      toast({ title: isEdit ? 'Library updated' : 'Library created' });
      onOpenChange(false);
      onSuccess?.(result);
    } catch {
      toast({
        title: isEdit ? 'Failed to update library' : 'Failed to create library',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit library' : 'New library'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="library-name">Name</Label>
            <Input
              id="library-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Library name"
              required
              autoFocus
              maxLength={255}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Color</Label>
            <div className="flex gap-2">
              {LIBRARY_COLORS.map((c) => {
                const grad = libraryGradient(c);
                const selected = color === c;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    aria-label={c}
                    aria-pressed={selected}
                    className={cn(
                      'h-8 w-8 rounded-lg ring-offset-2 ring-offset-background transition',
                      selected ? 'ring-2 ring-ring' : 'hover:scale-105',
                    )}
                    style={{ background: grad.background }}
                  />
                );
              })}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving || !name.trim()}>
              {isSaving ? 'Saving...' : isEdit ? 'Save changes' : 'Create library'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
