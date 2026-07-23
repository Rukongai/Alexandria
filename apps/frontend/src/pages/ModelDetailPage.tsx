import * as React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, AlertTriangle, Download, GitMerge, Loader2, Upload, X } from 'lucide-react';
import type { ModelCard, ModelDetail } from '@alexandria/shared';
import { addModelsToCollection, getCollections } from '../api/collections';
import {
  createModelFolder,
  deleteModelFile,
  deleteModelFolder,
  extractModelArchive,
  getModel,
  getModelFiles,
  getModels,
  mergeModels,
  updateModelFile,
  updateModelFolder,
  uploadModelFiles,
} from '../api/models';
import { ModelHero } from '../components/models/ModelHero';
import { ModelDetailPanel } from '../components/models/ModelDetailPanel';
import { ModelBreadcrumb } from '../components/models/ModelBreadcrumb';
import { ModelViewer3DModal } from '../components/models/ModelViewer3DModal';
import { TextFilePreviewModal } from '../components/models/TextFilePreviewModal';
import { ModelDetailSkeleton } from '../components/models/ModelDetailSkeleton';
import { collectStlFiles, type StlFileRef, type TextFileRef } from '../lib/model-files';
import { useLibraryPath } from '../hooks/use-libraries';
import { Button, buttonVariants } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { useToast } from '../hooks/use-toast';
import { formatFileSize } from '../lib/format';
import { cn } from '../lib/utils';

type FileAction =
  | { type: 'create-folder'; path: string }
  | { type: 'rename-file'; fileId: string; filename: string }
  | { type: 'move-file'; fileId: string; parentPath: string }
  | { type: 'delete-file'; fileId: string; name: string }
  | { type: 'extract-archive'; fileId: string; name: string }
  | { type: 'move-files'; fileIds: string[]; parentPath: string }
  | { type: 'delete-files'; fileIds: string[] }
  | { type: 'rename-folder'; path: string; name: string }
  | { type: 'move-folder'; path: string; parentPath: string }
  | { type: 'delete-folder'; path: string; name: string };

function fileActionStatus(action: FileAction | undefined): string | undefined {
  if (!action) return undefined;
  switch (action.type) {
    case 'create-folder': return 'Creating folder…';
    case 'rename-file': return 'Renaming file…';
    case 'move-file': return 'Moving file…';
    case 'delete-file': return 'Deleting file…';
    case 'extract-archive': return 'Extracting archive…';
    case 'move-files': return `Moving ${action.fileIds.length} files…`;
    case 'delete-files': return `Deleting ${action.fileIds.length} files…`;
    case 'rename-folder': return 'Renaming folder…';
    case 'move-folder': return 'Moving folder…';
    case 'delete-folder': return 'Deleting folder…';
  }
}

export function ModelDetailPage() {
  const { id } = useParams<{ id: string }>();
  const libPath = useLibraryPath();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    data: model,
    isLoading: modelLoading,
    isError: modelError,
    error: modelErr,
  } = useQuery({
    queryKey: ['model', id],
    queryFn: () => getModel(id!),
    enabled: Boolean(id),
  });

  const { data: fileTree = [], isLoading: filesLoading } = useQuery({
    queryKey: ['model-files', id],
    queryFn: () => getModelFiles(id!),
    enabled: Boolean(id),
  });

  const collectionsQuery = useQuery({
    queryKey: ['collections'],
    queryFn: () => getCollections().then((response) => response.data),
    enabled: Boolean(model),
  });

  const addToCollectionsMutation = useMutation({
    mutationFn: async (collectionIds: string[]) => {
      if (!id) throw new Error('Model id is required');
      const results = await Promise.allSettled(
        collectionIds.map((collectionId) => addModelsToCollection(collectionId, [id])),
      );
      const failureCount = results.filter((result) => result.status === 'rejected').length;
      if (failureCount > 0) {
        throw new Error(
          `${failureCount} of ${collectionIds.length} collection update${collectionIds.length === 1 ? '' : 's'} failed.`,
        );
      }
    },
    onSuccess: (_, collectionIds) => {
      toast({
        title: `Added to ${collectionIds.length} collection${collectionIds.length === 1 ? '' : 's'}`,
      });
    },
    onError: (error) => {
      toast({
        title: 'Could not add to collections',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['model', id] }),
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['collections'] }),
        queryClient.invalidateQueries({ queryKey: ['collection'] }),
        queryClient.invalidateQueries({ queryKey: ['collection-models'] }),
        queryClient.invalidateQueries({ queryKey: ['search'] }),
        queryClient.invalidateQueries({ queryKey: ['smart-collection'] }),
        queryClient.invalidateQueries({ queryKey: ['smart-collections'] }),
        queryClient.invalidateQueries({ queryKey: ['smart-preview'] }),
      ]);
    },
  });

  const isLoading = modelLoading || filesLoading;

  // STL files discovered from the file tree (drives the 3D viewer).
  const stlFiles = React.useMemo(
    () => (id ? collectStlFiles(fileTree, id) : []),
    [fileTree, id],
  );

  const [viewerOpen, setViewerOpen] = React.useState(false);
  const [activeStl, setActiveStl] = React.useState<StlFileRef | null>(null);
  const [textPreviewOpen, setTextPreviewOpen] = React.useState(false);
  const [activeTextFile, setActiveTextFile] = React.useState<TextFileRef | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = React.useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = React.useState(false);
  const [selectedImageFileId, setSelectedImageFileId] = React.useState<string | null>(null);

  const fileMutation = useMutation({
    mutationFn: async (action: FileAction) => {
      if (!id) throw new Error('Model id is required');
      switch (action.type) {
        case 'create-folder':
          await createModelFolder(id, action.path);
          return 'Folder created';
        case 'rename-file':
          await updateModelFile(id, action.fileId, { filename: action.filename });
          return 'File renamed';
        case 'move-file':
          await updateModelFile(id, action.fileId, { parentPath: action.parentPath });
          return 'File moved';
        case 'delete-file':
          await deleteModelFile(id, action.fileId);
          return 'File deleted';
        case 'extract-archive': {
          const result = await extractModelArchive(id, action.fileId);
          return `Extracted ${result.addedFileCount} file${result.addedFileCount === 1 ? '' : 's'} to ${result.destinationPath}`;
        }
        case 'move-files':
          await Promise.all(
            action.fileIds.map((fileId) => updateModelFile(id, fileId, { parentPath: action.parentPath })),
          );
          return `${action.fileIds.length} file${action.fileIds.length === 1 ? '' : 's'} moved`;
        case 'delete-files':
          await Promise.all(action.fileIds.map((fileId) => deleteModelFile(id, fileId)));
          return `${action.fileIds.length} file${action.fileIds.length === 1 ? '' : 's'} deleted`;
        case 'rename-folder':
          await updateModelFolder(id, { path: action.path, name: action.name });
          return 'Folder renamed';
        case 'move-folder':
          await updateModelFolder(id, { path: action.path, parentPath: action.parentPath });
          return 'Folder moved';
        case 'delete-folder':
          await deleteModelFolder(id, action.path);
          return 'Folder deleted';
      }
    },
    onSuccess: async (title) => {
      if (!id) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['model', id] }),
        queryClient.invalidateQueries({ queryKey: ['model-files', id] }),
        queryClient.invalidateQueries({ queryKey: ['models'] }),
      ]);
      toast({ title });
    },
    onError: (error) => {
      toast({
        title: 'File update failed',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    },
  });

  const activeFileActionStatus = fileMutation.isPending
    ? fileActionStatus(fileMutation.variables)
    : undefined;

  function runFileAction(action: FileAction): Promise<void> {
    return fileMutation.mutateAsync(action).then(() => undefined);
  }

  function openViewer(stl: StlFileRef) {
    setActiveStl(stl);
    setViewerOpen(true);
  }

  function openTextPreview(file: TextFileRef) {
    setActiveTextFile(file);
    setTextPreviewOpen(true);
  }

  React.useEffect(() => {
    if (!model) {
      setSelectedImageFileId(null);
      return;
    }

    const selectedStillExists = model.images.some((image) => image.id === selectedImageFileId);
    if (!selectedStillExists) {
      setSelectedImageFileId(model.images[0]?.id ?? null);
    }
  }, [model, selectedImageFileId]);

  return (
    <div className="flex flex-col gap-4 max-w-[1400px] mx-auto p-3 sm:p-6">
      {/* Header: navigation, model action, and breadcrumb */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Link
            to={libPath('/')}
            className="inline-flex items-center gap-0.5 h-8 px-2 -ml-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="Back to Library"
            title="Back to Library"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Back to Library</span>
          </Link>
          {model && !isLoading && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => setUploadDialogOpen(true)}
                aria-label="Upload files"
                title="Upload files"
              >
                <Upload className="h-4 w-4" />
                <span className="hidden sm:inline">Upload</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => setMergeDialogOpen(true)}
                aria-label="Merge models"
                title="Merge models"
              >
                <GitMerge className="h-4 w-4" />
                <span className="hidden sm:inline">Merge</span>
              </Button>
              <a
                href={`/api/models/${model.id}/download`}
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-2')}
                download={`${model.slug}.zip`}
                aria-label="Download ZIP"
                title="Download ZIP"
              >
                <Download className="h-4 w-4" />
                <span className="hidden sm:inline">Download ZIP</span>
              </a>
            </div>
          )}
        </div>
        {model && !isLoading && (
          <ModelBreadcrumb
            collection={model.collections[0] ?? null}
            modelName={model.name}
          />
        )}
      </div>

      {isLoading && <ModelDetailSkeleton />}

      {modelError && !isLoading && (
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive/70" />
          <div>
            <p className="text-lg font-semibold text-foreground">Model not found</p>
            <p className="text-sm text-muted-foreground mt-1">
              {(modelErr as Error)?.message ?? 'This model could not be loaded.'}
            </p>
          </div>
          <Link
            to={libPath('/')}
            className="inline-flex items-center justify-center h-9 px-4 rounded-md border border-input bg-background text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            Go to Library
          </Link>
        </div>
      )}

      {model && !isLoading && (
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Hero column */}
          <div className="flex-1 min-w-0">
            <ModelHero
              model={model}
              stlFiles={stlFiles}
              onOpenViewer={openViewer}
              selectedImageFileId={selectedImageFileId}
              onSelectImage={setSelectedImageFileId}
            />
          </div>

          {/* Tabbed panel column */}
          <div className="lg:w-[380px] xl:w-[420px] flex-shrink-0">
            <ModelDetailPanel
              model={model}
              fileTree={fileTree}
              onOpenStl={openViewer}
              onOpenText={openTextPreview}
              selectedImageFileId={selectedImageFileId}
              onSelectImageFile={setSelectedImageFileId}
              fileActionsDisabled={fileMutation.isPending}
              fileActionStatus={activeFileActionStatus}
              onCreateFolder={(path) => fileMutation.mutate({ type: 'create-folder', path })}
              onRenameFile={(fileId, filename) => fileMutation.mutate({ type: 'rename-file', fileId, filename })}
              onMoveFile={(fileId, parentPath) => runFileAction({ type: 'move-file', fileId, parentPath })}
              onDeleteFile={(fileId, name) => fileMutation.mutate({ type: 'delete-file', fileId, name })}
              onExtractArchive={(fileId, name) => fileMutation.mutate({ type: 'extract-archive', fileId, name })}
              onMoveFiles={(fileIds, parentPath) => runFileAction({ type: 'move-files', fileIds, parentPath })}
              onDeleteFiles={(fileIds) => fileMutation.mutate({ type: 'delete-files', fileIds })}
              onRenameFolder={(path, name) => fileMutation.mutate({ type: 'rename-folder', path, name })}
              onMoveFolder={(path, parentPath) => runFileAction({ type: 'move-folder', path, parentPath })}
              onDeleteFolder={(path, name) => fileMutation.mutate({ type: 'delete-folder', path, name })}
              allCollections={collectionsQuery.data ?? []}
              collectionsLoading={collectionsQuery.isLoading}
              collectionsError={collectionsQuery.isError}
              collectionAddPending={addToCollectionsMutation.isPending}
              onRetryCollections={() => void collectionsQuery.refetch()}
              onAddToCollections={(collectionIds) =>
                addToCollectionsMutation.mutateAsync(collectionIds).then(() => undefined)
              }
            />
          </div>
        </div>
      )}

      <ModelViewer3DModal
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        stlFiles={stlFiles}
        initialStl={activeStl}
      />
      <TextFilePreviewModal
        open={textPreviewOpen}
        onOpenChange={setTextPreviewOpen}
        file={activeTextFile}
      />

      {model && (
        <>
          <UploadFilesDialog
            model={model}
            open={uploadDialogOpen}
            onOpenChange={setUploadDialogOpen}
          />
          <MergeModelsDialog
            targetModel={model}
            open={mergeDialogOpen}
            onOpenChange={setMergeDialogOpen}
          />
        </>
      )}
    </div>
  );
}

interface UploadFilesDialogProps {
  model: ModelDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function UploadFilesDialog({ model, open, onOpenChange }: UploadFilesDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [files, setFiles] = React.useState<File[]>([]);
  const [progress, setProgress] = React.useState(0);
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);

  const mutation = useMutation({
    mutationFn: async () => {
      if (files.length === 0) throw new Error('Choose files first');
      return uploadModelFiles(model.id, files, setProgress);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['model', model.id] }),
        queryClient.invalidateQueries({ queryKey: ['model-files', model.id] }),
        queryClient.invalidateQueries({ queryKey: ['models'] }),
      ]);
      toast({
        title: `${files.length} file${files.length === 1 ? '' : 's'} uploaded`,
      });
      setFiles([]);
      setProgress(0);
      onOpenChange(false);
    },
    onError: (error) => {
      toast({
        title: 'Upload failed',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Files</DialogTitle>
          <DialogDescription>
            Add loose files or archive contents to {model.name}.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Label htmlFor="model-file-upload">Files</Label>
          <input
            ref={inputRef}
            id="model-file-upload"
            type="file"
            multiple
            className="sr-only"
            onChange={(event) => setFiles(Array.from(event.currentTarget.files ?? []))}
            disabled={mutation.isPending}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => inputRef.current?.click()}
              disabled={mutation.isPending}
              className="gap-2"
            >
              <Upload className="h-4 w-4" />
              Choose Files
            </Button>
            {files.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {files.length} selected · {formatFileSize(totalSize)}
              </span>
            )}
          </div>

          {files.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-md border">
              {files.map((selectedFile, index) => (
                <div
                  key={`${selectedFile.name}-${selectedFile.size}-${index}`}
                  className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{selectedFile.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatFileSize(selectedFile.size)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                    disabled={mutation.isPending}
                    className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                    aria-label={`Remove ${selectedFile.name}`}
                    title="Remove"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {mutation.isPending && (
            <div className="h-2 overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${Math.max(8, progress)}%` }}
              />
            </div>
          )}
        </div>

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
            onClick={() => mutation.mutate()}
            disabled={files.length === 0 || mutation.isPending}
            className="gap-2"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Upload {files.length > 1 ? files.length : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface MergeModelsDialogProps {
  targetModel: ModelDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function MergeModelsDialog({ targetModel, open, onOpenChange }: MergeModelsDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [query, setQuery] = React.useState('');
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ['merge-candidates', query],
    queryFn: () =>
      getModels({
        q: query,
        sort: 'name',
        sortDir: 'asc',
        pageSize: 30,
        status: 'ready',
      }),
    enabled: open,
  });

  const candidates: ModelCard[] = (data?.data ?? []).filter(
    (candidate) => candidate.id !== targetModel.id,
  );

  const mutation = useMutation({
    mutationFn: () => mergeModels(targetModel.id, [...selectedIds]),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['model', targetModel.id] }),
        queryClient.invalidateQueries({ queryKey: ['model-files', targetModel.id] }),
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['collections'] }),
      ]);
      toast({
        title: `Merged ${result.mergedModelIds.length} model${result.mergedModelIds.length === 1 ? '' : 's'}`,
        description: `${result.movedFileCount} file${result.movedFileCount === 1 ? '' : 's'} moved.`,
      });
      setSelectedIds(new Set());
      setQuery('');
      onOpenChange(false);
    },
    onError: (error) => {
      toast({
        title: 'Merge failed',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    },
  });

  function toggleCandidate(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Merge Models</DialogTitle>
          <DialogDescription>
            Selected models will be folded into {targetModel.name} and then removed.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Label htmlFor="model-merge-search">Source models</Label>
          <Input
            id="model-merge-search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search models"
            disabled={mutation.isPending}
          />

          <div className="max-h-72 overflow-y-auto rounded-md border">
            {isLoading && (
              <div className="flex h-24 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading
              </div>
            )}
            {!isLoading && candidates.length === 0 && (
              <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                No ready models found.
              </div>
            )}
            {!isLoading &&
              candidates.map((candidate) => (
                <label
                  key={candidate.id}
                  className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 last:border-b-0 hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(candidate.id)}
                    onChange={() => toggleCandidate(candidate.id)}
                    disabled={mutation.isPending}
                    className="h-4 w-4 rounded border border-input bg-background accent-primary"
                    aria-label={`Select ${candidate.name}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{candidate.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {candidate.fileCount} {candidate.fileCount === 1 ? 'file' : 'files'} ·{' '}
                      {formatFileSize(candidate.totalSizeBytes)}
                    </div>
                  </div>
                </label>
              ))}
          </div>
        </div>

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
            onClick={() => mutation.mutate()}
            disabled={selectedIds.size === 0 || mutation.isPending}
            className="gap-2"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
