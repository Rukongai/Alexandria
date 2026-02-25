import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Library, CreateLibraryRequest, UpdateLibraryRequest } from '@alexandria/shared';
import { pathTemplateSchema } from '@alexandria/shared';
import { createLibrary, updateLibrary } from '../../api/libraries';
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

interface LibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  library?: Library;
  onSuccess?: (library: Library) => void;
}

export function LibraryDialog({ open, onOpenChange, library, onSuccess }: LibraryDialogProps) {
  const isEdit = !!library;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [pathTemplate, setPathTemplate] = useState('');
  const [pathTemplateError, setPathTemplateError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (open) {
      setName(library?.name ?? '');
      setRootPath(library?.rootPath ?? '');
      setPathTemplate(library?.pathTemplate ?? '');
      setPathTemplateError(undefined);
    }
  }, [open, library]);

  const createMutation = useMutation({
    mutationFn: (data: CreateLibraryRequest) => createLibrary(data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
      toast({ title: 'Library created' });
      onOpenChange(false);
      onSuccess?.(result);
    },
    onError: () => {
      toast({ title: 'Failed to create library', variant: 'destructive' });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: UpdateLibraryRequest) => updateLibrary(library!.id, data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
      toast({ title: 'Library updated' });
      onOpenChange(false);
      onSuccess?.(result);
    },
    onError: () => {
      toast({ title: 'Failed to update library', variant: 'destructive' });
    },
  });

  const isLoading = createMutation.isPending || updateMutation.isPending;

  function validatePathTemplate(value: string): string | undefined {
    const result = pathTemplateSchema.safeParse(value);
    if (!result.success) {
      return result.error.errors[0]?.message ?? 'Invalid path template';
    }
    return undefined;
  }

  function handlePathTemplateChange(value: string) {
    setPathTemplate(value);
    if (pathTemplateError) {
      setPathTemplateError(validatePathTemplate(value));
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const templateError = validatePathTemplate(pathTemplate);
    if (templateError) {
      setPathTemplateError(templateError);
      return;
    }

    if (isEdit) {
      updateMutation.mutate({
        name: name.trim(),
        rootPath: rootPath.trim(),
        pathTemplate: pathTemplate.trim(),
      });
    } else {
      createMutation.mutate({
        name: name.trim(),
        rootPath: rootPath.trim(),
        pathTemplate: pathTemplate.trim(),
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Library' : 'New Library'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="library-name">Name</Label>
            <Input
              id="library-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Main Library"
              required
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="library-root-path">Root Path</Label>
            <Input
              id="library-root-path"
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder="/data/libraries"
              required
            />
            <p className="text-xs text-muted-foreground">
              Absolute path on the server filesystem where this library's files will be stored.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="library-path-template">Path Template</Label>
            <Input
              id="library-path-template"
              value={pathTemplate}
              onChange={(e) => handlePathTemplateChange(e.target.value)}
              placeholder="{library}/{model}"
              required
            />
            {pathTemplateError ? (
              <p className="text-xs text-destructive">{pathTemplateError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Defines the folder structure inside the root path.{' '}
                <span className="font-mono">{'{library}'}</span> must be first,{' '}
                <span className="font-mono">{'{model}'}</span> must be last. Use{' '}
                <span className="font-mono">{'{metadata.<slug>}'}</span> for metadata-based
                subfolders in between (e.g.{' '}
                <span className="font-mono">{'{library}/{metadata.artist}/{model}'}</span>).
              </p>
            )}
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
            <Button
              type="submit"
              disabled={isLoading || !name.trim() || !rootPath.trim() || !pathTemplate.trim()}
            >
              {isLoading ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Library'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
