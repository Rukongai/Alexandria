import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Plus, MoreVertical, Pencil, Star, Trash2 } from 'lucide-react';
import type { LibrarySummary } from '@alexandria/shared';
import { useLibraries } from '../hooks/use-libraries';
import { useToast } from '../hooks/use-toast';
import { libraryGradient, libraryInitials } from '../lib/library-color';
import { LibraryDialog } from '../components/libraries/LibraryDialog';
import { AlertDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';

export function AllLibrariesPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { libraries, isLoading, setDefaultLibrary, deleteLibrary } = useLibraries();

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<LibrarySummary | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<LibrarySummary | undefined>(undefined);
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleSetDefault(lib: LibrarySummary) {
    try {
      await setDefaultLibrary(lib.id);
      toast({ title: `"${lib.name}" is now your default library` });
    } catch {
      toast({ title: 'Failed to set default library', variant: 'destructive' });
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteLibrary(deleteTarget.id);
      toast({ title: 'Library deleted' });
      setDeleteTarget(undefined);
    } catch {
      toast({ title: 'Failed to delete library', variant: 'destructive' });
    } finally {
      setIsDeleting(false);
    }
  }

  /** Why a library cannot be deleted, or null if it can. */
  function deleteBlockedReason(lib: LibrarySummary): string | null {
    if (lib.isDefault) return 'Default library — set another as default first';
    if (libraries.length <= 1) return 'You must keep at least one library';
    if (lib.modelCount > 0 || lib.collectionCount > 0)
      return 'Library still contains models or collections';
    return null;
  }

  return (
    <div className="ax-app min-h-screen" style={{ background: 'var(--ax-bg)', color: 'var(--ax-fg)' }}>
      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="flex items-center gap-2.5 mb-8">
          <BookOpen className="h-6 w-6" style={{ color: 'var(--ax-amber)' }} />
          <h1 className="text-2xl font-semibold tracking-tight">Libraries</h1>
        </header>

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-40 rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {libraries.map((lib) => {
              const grad = libraryGradient(lib.color);
              const blocked = deleteBlockedReason(lib);
              return (
                <div
                  key={lib.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/lib/${lib.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/lib/${lib.id}`);
                    }
                  }}
                  className="group relative flex flex-col rounded-xl border p-4 text-left transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
                  style={{ background: 'var(--ax-bg-elev)', borderColor: 'var(--ax-border)' }}
                >
                  <div className="flex items-start justify-between">
                    <div
                      className="flex items-center justify-center rounded-lg font-bold"
                      style={{
                        width: 44,
                        height: 44,
                        background: grad.background,
                        color: grad.color,
                        fontSize: '15px',
                      }}
                    >
                      {libraryInitials(lib.name)}
                    </div>

                    {/* Stop menu clicks from bubbling to the card's navigate handler */}
                    <div onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 opacity-0 group-hover:opacity-100"
                            aria-label={`Actions for ${lib.name}`}
                          >
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditTarget(lib)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Rename
                          </DropdownMenuItem>
                          {!lib.isDefault && (
                            <DropdownMenuItem onClick={() => handleSetDefault(lib)}>
                              <Star className="mr-2 h-4 w-4" />
                              Set as default
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={!!blocked}
                            className="text-destructive focus:text-destructive"
                            onClick={() => {
                              if (!blocked) setDeleteTarget(lib);
                            }}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                          {blocked && (
                            <p className="px-2 pb-1 pt-0.5 text-[11px] leading-tight text-muted-foreground">
                              {blocked}
                            </p>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <h2 className="font-semibold truncate" style={{ fontSize: '15px' }}>
                      {lib.name}
                    </h2>
                    {lib.isDefault && (
                      <span className="ax-chip ax-chip-amber text-[10px]">Default</span>
                    )}
                  </div>
                  <p className="ax-mono mt-1" style={{ fontSize: '12px', color: 'var(--ax-fg-muted)' }}>
                    {lib.modelCount} {lib.modelCount === 1 ? 'model' : 'models'} ·{' '}
                    {lib.collectionCount}{' '}
                    {lib.collectionCount === 1 ? 'collection' : 'collections'}
                  </p>
                </div>
              );
            })}

            {/* New library card */}
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-4 transition hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-[136px]"
              style={{ borderColor: 'var(--ax-border)', color: 'var(--ax-fg-muted)' }}
            >
              <Plus className="h-6 w-6" />
              <span className="text-sm font-medium">New library</span>
            </button>
          </div>
        )}
      </div>

      <LibraryDialog open={createOpen} onOpenChange={setCreateOpen} />
      <LibraryDialog
        open={!!editTarget}
        onOpenChange={(o) => !o && setEditTarget(undefined)}
        library={editTarget}
      />
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(undefined)}
        title={`Delete "${deleteTarget?.name}"?`}
        description="This permanently deletes the library. Its models and collections must be moved or removed first."
        confirmLabel="Delete"
        destructive
        isLoading={isDeleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}
