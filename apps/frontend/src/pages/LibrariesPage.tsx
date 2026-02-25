import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Database } from 'lucide-react';
import type { Library } from '@alexandria/shared';
import { getLibraries, deleteLibrary } from '../api/libraries';
import { useToast } from '../hooks/use-toast';
import { LibraryDialog } from '../components/libraries/LibraryDialog';
import { AlertDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';

export function LibrariesPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Library | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<Library | undefined>(undefined);

  const { data: libraries, isLoading } = useQuery({
    queryKey: ['libraries'],
    queryFn: () => getLibraries(),
    select: (res) => res.data,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteLibrary(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
      toast({ title: 'Library deleted' });
      setDeleteTarget(undefined);
    },
    onError: () => {
      toast({ title: 'Failed to delete library', variant: 'destructive' });
    },
  });

  return (
    <div className="flex flex-col gap-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Libraries</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage storage libraries and their folder layout templates.
        </p>
      </div>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">Storage Libraries</h2>
            <p className="text-sm text-muted-foreground">
              Each library defines a root path and how models are organized within it.
            </p>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            New Library
          </Button>
        </div>

        <div className="rounded-xl border overflow-hidden">
          {isLoading ? (
            <div className="flex flex-col divide-y">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-4">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-4 w-32 ml-auto" />
                </div>
              ))}
            </div>
          ) : !libraries || libraries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <Database className="h-10 w-10 text-muted-foreground/40" />
              <div>
                <p className="text-sm font-medium text-foreground">No libraries yet</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Create a library to define where models are stored.
                </p>
              </div>
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4 mr-1.5" />
                Create your first library
              </Button>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left font-medium text-muted-foreground px-4 py-2.5">Name</th>
                  <th className="text-left font-medium text-muted-foreground px-4 py-2.5">
                    Root Path
                  </th>
                  <th className="text-left font-medium text-muted-foreground px-4 py-2.5">
                    Path Template
                  </th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {libraries.map((lib) => (
                  <LibraryRow
                    key={lib.id}
                    library={lib}
                    onEdit={() => setEditTarget(lib)}
                    onDelete={() => setDeleteTarget(lib)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <LibraryDialog open={createOpen} onOpenChange={setCreateOpen} />

      {editTarget && (
        <LibraryDialog
          open={!!editTarget}
          onOpenChange={(open) => {
            if (!open) setEditTarget(undefined);
          }}
          library={editTarget}
        />
      )}

      {deleteTarget && (
        <AlertDialog
          open={!!deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(undefined);
          }}
          title={`Delete "${deleteTarget.name}"?`}
          description="This library definition will be removed. Files already stored on disk will not be deleted."
          confirmLabel="Delete Library"
          destructive
          isLoading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
        />
      )}
    </div>
  );
}

interface LibraryRowProps {
  library: Library;
  onEdit: () => void;
  onDelete: () => void;
}

function LibraryRow({ library, onEdit, onDelete }: LibraryRowProps) {
  return (
    <tr className="hover:bg-muted/20 transition-colors">
      <td className="px-4 py-3">
        <span className="font-medium text-foreground">{library.name}</span>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
        {library.rootPath}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
        {library.pathTemplate}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  );
}
