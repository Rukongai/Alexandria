import * as React from 'react';
import {
  Folder,
  FolderOpen,
  Box,
  Image,
  FileText,
  File,
  Download,
  Eye,
  FolderInput,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  SquareCheck,
  Trash2,
  PackageOpen,
  Archive,
  Loader2,
  Scissors,
  Copy,
} from 'lucide-react';
import type { FileTreeNode, FileType } from '@alexandria/shared';
import { formatFileSize } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Model3DIcon } from '../icons';
import {
  isTextPreviewFileName,
  isArchiveFileName,
  makeStlRef,
  makeTextFileRef,
  type StlFileRef,
  type TextFileRef,
} from '../../lib/model-files';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Badge } from '../ui/badge';

interface FileNodeProps {
  node: FileTreeNode;
  depth: number;
  /** Ancestor directory names, used to reconstruct STL relative paths. */
  pathPrefix: string[];
  modelId: string;
  onOpenStl?: (stl: StlFileRef) => void;
  onOpenText?: (file: TextFileRef) => void;
  selectedImageFileId?: string | null;
  onSelectImageFile?: (fileId: string) => void;
  defaultExpanded?: boolean;
  disabled?: boolean;
  selectedFileIds: Set<string>;
  onToggleFileSelection: (fileId: string) => void;
  onCreateFolder?: (parentPath: string) => void;
  onRenameFile?: (fileId: string, filename: string) => void;
  onMoveFile?: (fileId: string, parentPath: string) => Promise<void>;
  onDeleteFile?: (fileId: string, name: string) => void;
  onExtractArchive?: (fileId: string, name: string) => void;
  onRenameFolder?: (path: string, name: string) => void;
  onMoveFolder?: (path: string, parentPath: string) => Promise<void>;
  onCompressFolder?: (path: string, name: string) => void;
  onDeleteFolder?: (path: string, name: string) => void;
  onSplitFolder?: (path: string, name: string) => void;
  selectionMode: boolean;
  onRequestMove: (request: MoveRequest) => void;
}

function FileIcon({ fileType }: { fileType?: FileType }) {
  switch (fileType) {
    case 'stl':
      return <Box className="h-4 w-4 text-primary flex-shrink-0" />;
    case 'image':
      return <Image className="h-4 w-4 text-accent-foreground flex-shrink-0" />;
    case 'document':
      return <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
    default:
      return <File className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
  }
}

function containsFileId(nodes: FileTreeNode[] | undefined, fileId: string): boolean {
  if (!nodes) return false;
  for (const node of nodes) {
    if (node.type === 'file' && node.id === fileId) return true;
    if (node.type === 'directory' && containsFileId(node.children, fileId)) return true;
  }
  return false;
}

function joinPath(segments: string[]): string {
  return segments.filter(Boolean).join('/');
}

function promptName(label: string, current = ''): string | null {
  const value = window.prompt(label, current);
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function modelFileDownloadUrl(modelId: string, segments: string[]): string {
  return `/api/files/models/${modelId}/${segments.map(encodeURIComponent).join('/')}?download=1`;
}

interface FileSelectionTarget {
  id: string;
  name: string;
  segments: string[];
}

interface FolderDestination {
  path: string;
  name: string;
  depth: number;
}

type MoveRequest =
  | { type: 'files'; fileIds: string[]; title: string }
  | { type: 'folder'; folderPath: string; folderName: string };

function collectFileTargets(
  nodes: FileTreeNode[],
  prefix: string[] = [],
): FileSelectionTarget[] {
  const files: FileSelectionTarget[] = [];

  for (const node of nodes) {
    const segments = [...prefix, node.name];
    if (node.type === 'file' && node.id) {
      files.push({ id: node.id, name: node.name, segments });
    } else if (node.type === 'directory') {
      files.push(...collectFileTargets(node.children ?? [], segments));
    }
  }

  return files;
}

function collectFolderDestinations(
  nodes: FileTreeNode[],
  prefix: string[] = [],
  depth = 0,
): FolderDestination[] {
  const folders: FolderDestination[] = [];

  for (const node of nodes) {
    if (node.type !== 'directory') continue;
    const segments = [...prefix, node.name];
    folders.push({ path: joinPath(segments), name: node.name, depth });
    folders.push(...collectFolderDestinations(node.children ?? [], segments, depth + 1));
  }

  return folders;
}

function downloadFiles(modelId: string, files: FileSelectionTarget[]): void {
  for (const file of files) {
    const link = document.createElement('a');
    link.href = modelFileDownloadUrl(modelId, file.segments);
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
}

function MoveDestinationDialog({
  open,
  onOpenChange,
  request,
  destinations,
  onCreateDestination,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: MoveRequest | null;
  destinations: FolderDestination[];
  onCreateDestination: (parentPath: string, name: string) => FolderDestination | null;
  onConfirm: (destinationPath: string) => Promise<void>;
}) {
  const [selectedPath, setSelectedPath] = React.useState('');
  const [newFolderParentPath, setNewFolderParentPath] = React.useState('');
  const [newFolderName, setNewFolderName] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const title = request?.type === 'folder' ? `Move ${request.folderName}` : 'Move Files';

  React.useEffect(() => {
    if (!open) {
      setSelectedPath('');
      setNewFolderParentPath('');
      setNewFolderName('');
      setIsSubmitting(false);
      return;
    }
    setSelectedPath(destinations[0]?.path ?? '');
    setNewFolderParentPath(destinations[0]?.path ?? '');
  }, [open, request]);

  function createDestination() {
    const created = onCreateDestination(newFolderParentPath, newFolderName);
    if (!created) return;
    setSelectedPath(created.path);
    setNewFolderParentPath(created.path);
    setNewFolderName('');
  }

  async function confirmMove(): Promise<void> {
    setIsSubmitting(true);
    try {
      await onConfirm(selectedPath);
    } catch {
      // The mutation owner reports the error. Keep this dialog open for retry.
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
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="max-h-64 overflow-y-auto rounded-md border border-border">
          {destinations.map((destination) => (
            <button
              key={destination.path || 'root'}
              type="button"
              onClick={() => setSelectedPath(destination.path)}
              disabled={isSubmitting}
              className={cn(
                'flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent',
                selectedPath === destination.path && 'bg-primary/10 text-primary hover:bg-primary/15',
              )}
              style={{ paddingLeft: `${12 + destination.depth * 16}px` }}
            >
              <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{destination.name}</span>
            </button>
          ))}
        </div>

        <div className="rounded-md border border-border p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-foreground">New Folder</span>
            <select
              value={newFolderParentPath}
              onChange={(event) => setNewFolderParentPath(event.currentTarget.value)}
              disabled={isSubmitting}
              className="h-8 max-w-[180px] rounded-md border border-input bg-background px-2 text-xs text-foreground"
            >
              {destinations.map((destination) => (
                <option key={destination.path || 'root'} value={destination.path}>
                  {destination.path || 'Model root'}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.currentTarget.value)}
              disabled={isSubmitting}
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
              aria-label="New folder name"
            />
            <button
              type="button"
              onClick={createDestination}
              disabled={isSubmitting || newFolderName.trim().length === 0}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-input px-2 text-xs font-medium hover:bg-accent disabled:opacity-50"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              New
            </button>
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
            className="inline-flex h-8 items-center rounded-md border border-input px-3 text-sm hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirmMove()}
            disabled={isSubmitting || destinations.length === 0}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {isSubmitting && (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            )}
            {isSubmitting ? 'Moving…' : 'Move'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FileNode({
  node,
  depth,
  pathPrefix,
  modelId,
  onOpenStl,
  onOpenText,
  selectedImageFileId,
  onSelectImageFile,
  defaultExpanded = false,
  disabled = false,
  selectedFileIds,
  onToggleFileSelection,
  onCreateFolder,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onExtractArchive,
  onRenameFolder,
  onMoveFolder,
  onCompressFolder,
  onDeleteFolder,
  onSplitFolder,
  selectionMode,
  onRequestMove,
}: FileNodeProps) {
  const containsSelectedImage = selectedImageFileId
    ? containsFileId(node.children, selectedImageFileId)
    : false;
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const paddingLeft = depth * 16;
  const nodePath = joinPath([...pathPrefix, node.name]);

  React.useEffect(() => {
    if (containsSelectedImage) {
      setExpanded(true);
    }
  }, [containsSelectedImage]);

  if (node.type === 'directory') {
    return (
      <div>
        <div
          className="flex items-center rounded text-sm group hover:bg-muted/60"
          style={{ paddingLeft: `${paddingLeft + 8}px` }}
        >
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-left"
            disabled={disabled}
          >
            {expanded ? (
              <FolderOpen className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            ) : (
              <Folder className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            )}
            <span className="font-medium text-foreground truncate" title={node.name}>
              {node.name}
            </span>
            {node.children && (
              <span className="text-xs text-muted-foreground ml-auto">
                {node.children.length}
              </span>
            )}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="mr-1 rounded-md p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100 disabled:opacity-50"
                disabled={disabled}
                aria-label={`Actions for folder ${node.name}`}
                title="Folder actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem
                onClick={() => {
                  const name = promptName('Folder name');
                  if (name) onCreateFolder?.(joinPath([nodePath, name]));
                }}
              >
                <FolderPlus className="mr-2 h-3.5 w-3.5" />
                New Folder
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  const name = promptName('Rename folder', node.name);
                  if (name) onRenameFolder?.(nodePath, name);
                }}
              >
                <Pencil className="mr-2 h-3.5 w-3.5" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  onRequestMove({ type: 'folder', folderPath: nodePath, folderName: node.name });
                }}
              >
                <FolderInput className="mr-2 h-3.5 w-3.5" />
                Move
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSplitFolder?.(nodePath, node.name)}>
                <Scissors className="mr-2 h-3.5 w-3.5" />
                Split into new model…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onCompressFolder?.(nodePath, node.name)}>
                <Archive className="mr-2 h-3.5 w-3.5" />
                Compress to 7z
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  if (window.confirm(`Delete folder "${node.name}" and all files inside it?`)) {
                    onDeleteFolder?.(nodePath, node.name);
                  }
                }}
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {expanded && node.children && (
          <div>
            {node.children.map((child, i) => (
              <FileNode
                key={`${child.name}-${i}`}
                node={child}
                depth={depth + 1}
                pathPrefix={[...pathPrefix, node.name]}
                modelId={modelId}
                onOpenStl={onOpenStl}
                onOpenText={onOpenText}
                selectedImageFileId={selectedImageFileId}
                onSelectImageFile={onSelectImageFile}
                disabled={disabled}
                selectedFileIds={selectedFileIds}
                onToggleFileSelection={onToggleFileSelection}
                onCreateFolder={onCreateFolder}
                onRenameFile={onRenameFile}
                onMoveFile={onMoveFile}
                onDeleteFile={onDeleteFile}
                onExtractArchive={onExtractArchive}
                onRenameFolder={onRenameFolder}
                onMoveFolder={onMoveFolder}
                onCompressFolder={onCompressFolder}
                onDeleteFolder={onDeleteFolder}
                onSplitFolder={onSplitFolder}
                selectionMode={selectionMode}
                onRequestMove={onRequestMove}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isStl = node.fileType === 'stl';
  const canView3D = isStl && Boolean(onOpenStl);
  const parentPath = joinPath(pathPrefix);
  const fileSegments = [...pathPrefix, node.name];
  const canPreviewText = !selectionMode && Boolean(onOpenText) && isTextPreviewFileName(node.name);
  const canExtractArchive = !selectionMode && Boolean(node.id) && isArchiveFileName(node.name);
  const isImage = node.fileType === 'image' && Boolean(node.id);
  const isSelectedImage = isImage && node.id === selectedImageFileId;
  const canSelectImage = !selectionMode && isImage && Boolean(onSelectImageFile);
  const isSelectedFile = Boolean(node.id && selectedFileIds.has(node.id));

  function selectImage() {
    if (selectionMode && node.id) {
      onToggleFileSelection(node.id);
      return;
    }
    if (canSelectImage && node.id) {
      onSelectImageFile!(node.id);
    }
  }

  return (
    <div
      role={canSelectImage || selectionMode ? 'button' : undefined}
      tabIndex={canSelectImage || selectionMode ? 0 : undefined}
      onClick={selectImage}
      onKeyDown={(event) => {
        if (!canSelectImage && !selectionMode) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectImage();
        }
      }}
      className={cn(
        'flex items-center gap-1.5 py-1 px-2 rounded text-sm group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        canSelectImage || selectionMode ? 'cursor-pointer hover:bg-muted/60' : 'hover:bg-muted/40',
        isSelectedImage && 'bg-primary/10 text-primary hover:bg-primary/15',
        isSelectedFile && !isSelectedImage && 'bg-primary/5',
      )}
      style={{ paddingLeft: `${paddingLeft + 8}px` }}
      aria-label={
        selectionMode
          ? `${isSelectedFile ? 'Deselect' : 'Select'} file ${node.name}`
          : canSelectImage
            ? `Select image ${node.name}`
            : undefined
      }
      aria-current={isSelectedImage ? 'true' : undefined}
    >
      {selectionMode && node.id && (
        <input
          type="checkbox"
          checked={isSelectedFile}
          disabled={disabled}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            event.stopPropagation();
            onToggleFileSelection(node.id!);
          }}
          className="h-3.5 w-3.5 flex-shrink-0 rounded border border-input bg-background accent-primary"
          aria-label={`Select file ${node.name}`}
        />
      )}
      <FileIcon fileType={node.fileType} />
      <span
        className={cn(
          'truncate flex-1 min-w-0',
          isSelectedImage ? 'text-primary font-medium' : 'text-foreground',
        )}
        title={node.name}
      >
        {node.name}
      </span>
      {node.isDuplicate && (
        <Badge
          variant="outline"
          className="h-5 flex-shrink-0 gap-1 border-amber-500/50 px-1.5 text-[10px] text-amber-700 dark:text-amber-300"
        >
          <Copy className="h-2.5 w-2.5" aria-hidden="true" />
          Duplicate
        </Badge>
      )}
      {canView3D && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenStl!(makeStlRef(modelId, [...pathPrefix, node.name]));
          }}
          className="flex items-center gap-1 flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium text-primary opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-primary/10 transition-all"
          aria-label={`View ${node.name} in 3D`}
        >
          <Model3DIcon className="h-3.5 w-3.5" />
          3D
        </button>
      )}
      {canPreviewText && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenText!(makeTextFileRef(modelId, fileSegments, node.sizeBytes));
          }}
          className="flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-primary opacity-0 transition-all hover:bg-primary/10 focus:opacity-100 group-hover:opacity-100"
          aria-label={`Preview ${node.name}`}
        >
          <Eye className="h-3.5 w-3.5" />
          Preview
        </button>
      )}
      {canExtractArchive && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onExtractArchive?.(node.id!, node.name);
          }}
          disabled={disabled}
          className="flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-primary opacity-0 transition-all hover:bg-primary/10 focus:opacity-100 group-hover:opacity-100 disabled:opacity-50"
          aria-label={`Extract ${node.name}`}
          title={`Extract ${node.name}`}
        >
          <PackageOpen className="h-3.5 w-3.5" />
          Extract
        </button>
      )}
      {node.sizeBytes !== undefined && (
        <span className="text-xs text-muted-foreground flex-shrink-0 ml-2">
          {formatFileSize(node.sizeBytes)}
        </span>
      )}
      {node.id && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(event) => event.stopPropagation()}
              className="rounded-md p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100 disabled:opacity-50"
              disabled={disabled}
              aria-label={`Actions for file ${node.name}`}
              title="File actions"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            {canExtractArchive && (
              <DropdownMenuItem onClick={() => onExtractArchive?.(node.id!, node.name)}>
                <PackageOpen className="mr-2 h-3.5 w-3.5" />
                Extract
              </DropdownMenuItem>
            )}
            {canPreviewText && (
              <DropdownMenuItem
                onClick={() => {
                  onOpenText!(makeTextFileRef(modelId, fileSegments, node.sizeBytes));
                }}
              >
                <Eye className="mr-2 h-3.5 w-3.5" />
                Preview
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => {
                downloadFiles(modelId, [{ id: node.id!, name: node.name, segments: fileSegments }]);
              }}
            >
              <Download className="mr-2 h-3.5 w-3.5" />
              Download
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                const name = promptName('Rename file', node.name);
                if (name && node.id) onRenameFile?.(node.id, name);
              }}
            >
              <Pencil className="mr-2 h-3.5 w-3.5" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                if (node.id) {
                  onRequestMove({ type: 'files', fileIds: [node.id], title: `Move ${node.name}` });
                }
              }}
            >
              <FolderInput className="mr-2 h-3.5 w-3.5" />
              Move
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive hover:text-destructive"
              onClick={() => {
                if (node.id && window.confirm(`Delete file "${node.name}"?`)) {
                  onDeleteFile?.(node.id, node.name);
                }
              }}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function countFiles(nodes: FileTreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === 'file') {
      count++;
    } else if (node.children) {
      count += countFiles(node.children);
    }
  }
  return count;
}

interface FileTreeProps {
  tree: FileTreeNode[];
  modelId: string;
  /** When provided, STL rows show a "view in 3D" affordance. */
  onOpenStl?: (stl: StlFileRef) => void;
  /** When provided, text-like rows show a preview affordance. */
  onOpenText?: (file: TextFileRef) => void;
  selectedImageFileId?: string | null;
  onSelectImageFile?: (fileId: string) => void;
  disabled?: boolean;
  operationStatus?: string;
  onCreateFolder?: (path: string) => void;
  onRenameFile?: (fileId: string, filename: string) => void;
  onMoveFile?: (fileId: string, parentPath: string) => Promise<void>;
  onDeleteFile?: (fileId: string, name: string) => void;
  onExtractArchive?: (fileId: string, name: string) => void;
  onMoveFiles?: (fileIds: string[], parentPath: string) => Promise<void>;
  onDeleteFiles?: (fileIds: string[]) => void;
  onRenameFolder?: (path: string, name: string) => void;
  onMoveFolder?: (path: string, parentPath: string) => Promise<void>;
  onCompressFolder?: (path: string, name: string) => void;
  onDeleteFolder?: (path: string, name: string) => void;
  onSplitFolder?: (path: string, name: string) => void;
}

export function FileTree({
  tree,
  modelId,
  onOpenStl,
  onOpenText,
  selectedImageFileId,
  onSelectImageFile,
  disabled = false,
  operationStatus,
  onCreateFolder,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onExtractArchive,
  onMoveFiles,
  onDeleteFiles,
  onRenameFolder,
  onMoveFolder,
  onCompressFolder,
  onDeleteFolder,
  onSplitFolder,
}: FileTreeProps) {
  const totalFiles = countFiles(tree);
  const allFiles = React.useMemo(() => collectFileTargets(tree), [tree]);
  const baseDestinations = React.useMemo(
    () => [
      { path: '', name: 'Model root', depth: 0 },
      ...collectFolderDestinations(tree).map((folder) => ({ ...folder, depth: folder.depth + 1 })),
    ],
    [tree],
  );
  const [selectedFileIds, setSelectedFileIds] = React.useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = React.useState(false);
  const [moveRequest, setMoveRequest] = React.useState<MoveRequest | null>(null);
  const [extraDestinations, setExtraDestinations] = React.useState<FolderDestination[]>([]);
  const selectedFiles = React.useMemo(
    () => allFiles.filter((file) => selectedFileIds.has(file.id)),
    [allFiles, selectedFileIds],
  );
  const allSelected = allFiles.length > 0 && selectedFiles.length === allFiles.length;
  const destinations = React.useMemo(() => {
    const byPath = new Map<string, FolderDestination>();
    for (const destination of [...baseDestinations, ...extraDestinations]) {
      byPath.set(destination.path, destination);
    }
    return [...byPath.values()].sort((a, b) => {
      if (a.path === '') return -1;
      if (b.path === '') return 1;
      return a.path.localeCompare(b.path, undefined, { sensitivity: 'base' });
    });
  }, [baseDestinations, extraDestinations]);
  const folderPathSet = React.useMemo(
    () => new Set(destinations.filter((destination) => destination.path).map((destination) => destination.path)),
    [destinations],
  );
  const fileByPath = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const file of allFiles) {
      map.set(joinPath(file.segments), file.id);
    }
    return map;
  }, [allFiles]);
  const moveDestinations = React.useMemo(() => {
    if (!moveRequest) return [];

    if (moveRequest.type === 'folder') {
      return destinations.filter((destination) => {
        if (destination.path === moveRequest.folderPath) return false;
        if (destination.path.startsWith(`${moveRequest.folderPath}/`)) return false;
        const candidatePath = joinPath([destination.path, moveRequest.folderName]);
        if (fileByPath.has(candidatePath)) return false;
        return !folderPathSet.has(candidatePath) || candidatePath === moveRequest.folderPath;
      });
    }

    const movingFileIds = new Set(moveRequest.fileIds);
    const movingFiles = allFiles.filter((file) => movingFileIds.has(file.id));
    return destinations.filter((destination) => {
      const candidatePaths = new Set<string>();
      for (const file of movingFiles) {
        const candidatePath = joinPath([destination.path, file.name]);
        if (candidatePaths.has(candidatePath)) return false;
        candidatePaths.add(candidatePath);
        if (folderPathSet.has(candidatePath)) return false;
        const existingFileId = fileByPath.get(candidatePath);
        if (existingFileId && !movingFileIds.has(existingFileId)) return false;
      }
      return true;
    });
  }, [allFiles, destinations, fileByPath, folderPathSet, moveRequest]);

  React.useEffect(() => {
    const currentFileIds = new Set(allFiles.map((file) => file.id));
    setSelectedFileIds((current) => {
      const next = new Set([...current].filter((fileId) => currentFileIds.has(fileId)));
      return next.size === current.size ? current : next;
    });
  }, [allFiles]);

  React.useEffect(() => {
    const currentPaths = new Set(baseDestinations.map((destination) => destination.path));
    setExtraDestinations((current) => {
      const next = current.filter((destination) => !currentPaths.has(destination.path));
      return next.length === current.length ? current : next;
    });
  }, [baseDestinations]);

  function toggleFileSelection(fileId: string): void {
    setSelectedFileIds((current) => {
      const next = new Set(current);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  function setAllSelected(checked: boolean): void {
    setSelectedFileIds(checked ? new Set(allFiles.map((file) => file.id)) : new Set());
  }

  function toggleSelectionMode(): void {
    setSelectionMode((current) => {
      if (current) {
        setSelectedFileIds(new Set());
      }
      return !current;
    });
  }

  function createMoveDestination(parentPath: string, name: string): FolderDestination | null {
    const folderName = name.trim();
    if (!folderName || folderName.includes('/') || folderName.includes('\\')) {
      window.alert('Folder name cannot be empty or contain path separators.');
      return null;
    }

    const parent = destinations.find((destination) => destination.path === parentPath);
    const path = joinPath([parentPath, folderName]);
    if (folderPathSet.has(path) || fileByPath.has(path)) {
      window.alert('That folder already exists.');
      return null;
    }

    const created = {
      path,
      name: folderName,
      depth: (parent?.depth ?? 0) + 1,
    };
    setExtraDestinations((current) => [...current, created]);
    return created;
  }

  async function confirmMove(destinationPath: string): Promise<void> {
    if (!moveRequest) return;
    if (moveRequest.type === 'folder') {
      await onMoveFolder?.(moveRequest.folderPath, destinationPath);
    } else if (moveRequest.fileIds.length === 1) {
      await onMoveFile?.(moveRequest.fileIds[0], destinationPath);
    } else {
      await onMoveFiles?.(moveRequest.fileIds, destinationPath);
      setSelectedFileIds(new Set());
    }
    setMoveRequest(null);
  }

  return (
    <div
      className="rounded-xl border border-border bg-card overflow-visible"
      aria-busy={Boolean(operationStatus)}
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border bg-muted/30">
        <span className="text-sm font-semibold text-foreground">Files</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleSelectionMode}
            disabled={disabled || allFiles.length === 0}
            className={cn(
              'rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50',
              selectionMode && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary',
            )}
            aria-pressed={selectionMode}
            aria-label={selectionMode ? 'Disable file multi-select' : 'Enable file multi-select'}
            title={selectionMode ? 'Disable multi-select' : 'Enable multi-select'}
          >
            <SquareCheck className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              const name = promptName('Folder name');
              if (name) onCreateFolder?.(name);
            }}
            disabled={disabled}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            aria-label="Create folder"
            title="Create folder"
          >
            <FolderPlus className="h-4 w-4" />
          </button>
          {operationStatus ? (
            <span
              role="status"
              aria-live="polite"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary"
            >
              <Loader2
                className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {operationStatus}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{totalFiles} files</span>
          )}
        </div>
      </div>
      {selectionMode && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-primary/5 px-3 py-2">
          <label className="mr-auto flex items-center gap-2 text-xs font-medium text-primary">
            <input
              type="checkbox"
              checked={allSelected}
              disabled={disabled || allFiles.length === 0}
              onChange={(event) => setAllSelected(event.currentTarget.checked)}
              className="h-3.5 w-3.5 rounded border border-input bg-background accent-primary"
              aria-label="Select all files"
            />
            {selectedFiles.length} selected
          </label>
          <button
            type="button"
            onClick={() => downloadFiles(modelId, selectedFiles)}
            disabled={disabled || selectedFiles.length === 0}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-foreground hover:bg-accent disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
          <button
            type="button"
            onClick={() => {
              setMoveRequest({
                type: 'files',
                fileIds: selectedFiles.map((file) => file.id),
                title: `Move ${selectedFiles.length} Files`,
              });
            }}
            disabled={disabled || selectedFiles.length === 0}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-foreground hover:bg-accent disabled:opacity-50"
          >
            <FolderInput className="h-3.5 w-3.5" />
            Move
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Delete ${selectedFiles.length} selected file${selectedFiles.length === 1 ? '' : 's'}?`)) {
                onDeleteFiles?.(selectedFiles.map((file) => file.id));
                setSelectedFileIds(new Set());
              }
            }}
            disabled={disabled || selectedFiles.length === 0}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
          <button
            type="button"
            onClick={() => setSelectedFileIds(new Set())}
            disabled={disabled}
            className="inline-flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            Clear
          </button>
        </div>
      )}
      <div className={cn('py-1', tree.length === 0 && 'p-4')}>
        {tree.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center">No files found</p>
        ) : (
          tree.map((node, i) => (
            <FileNode
              key={`${node.name}-${i}`}
              node={node}
              depth={0}
              pathPrefix={[]}
              modelId={modelId}
              onOpenStl={onOpenStl}
              onOpenText={onOpenText}
              selectedImageFileId={selectedImageFileId}
              onSelectImageFile={onSelectImageFile}
              defaultExpanded={true}
              disabled={disabled}
              selectedFileIds={selectedFileIds}
              onToggleFileSelection={toggleFileSelection}
              onCreateFolder={onCreateFolder}
              onRenameFile={onRenameFile}
              onMoveFile={onMoveFile}
              onDeleteFile={onDeleteFile}
              onExtractArchive={onExtractArchive}
              onRenameFolder={onRenameFolder}
              onMoveFolder={onMoveFolder}
              onCompressFolder={onCompressFolder}
              onDeleteFolder={onDeleteFolder}
              onSplitFolder={onSplitFolder}
              selectionMode={selectionMode}
              onRequestMove={setMoveRequest}
            />
          ))
        )}
      </div>
      <MoveDestinationDialog
        open={Boolean(moveRequest)}
        onOpenChange={(open) => {
          if (!open) setMoveRequest(null);
        }}
        request={moveRequest}
        destinations={moveDestinations}
        onCreateDestination={createMoveDestination}
        onConfirm={confirmMove}
      />
    </div>
  );
}
