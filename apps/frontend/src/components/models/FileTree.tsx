import * as React from 'react';
import {
  Folder,
  FolderOpen,
  Box,
  Image,
  FileText,
  File,
} from 'lucide-react';
import type { FileTreeNode, FileType } from '@alexandria/shared';
import { formatFileSize } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Model3DIcon } from '../icons';
import { makeStlRef, type StlFileRef } from '../../lib/model-files';

interface FileNodeProps {
  node: FileTreeNode;
  depth: number;
  /** Ancestor directory names, used to reconstruct STL relative paths. */
  pathPrefix: string[];
  modelId: string;
  onOpenStl?: (stl: StlFileRef) => void;
  selectedImageFileId?: string | null;
  onSelectImageFile?: (fileId: string) => void;
  defaultExpanded?: boolean;
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

function FileNode({
  node,
  depth,
  pathPrefix,
  modelId,
  onOpenStl,
  selectedImageFileId,
  onSelectImageFile,
  defaultExpanded = false,
}: FileNodeProps) {
  const containsSelectedImage = selectedImageFileId
    ? containsFileId(node.children, selectedImageFileId)
    : false;
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const paddingLeft = depth * 16;

  React.useEffect(() => {
    if (containsSelectedImage) {
      setExpanded(true);
    }
  }, [containsSelectedImage]);

  if (node.type === 'directory') {
    return (
      <div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-1.5 py-1 px-2 rounded hover:bg-muted/60 text-sm text-left group"
          style={{ paddingLeft: `${paddingLeft + 8}px` }}
        >
          {expanded ? (
            <FolderOpen className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          ) : (
            <Folder className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          )}
          <span className="font-medium text-foreground truncate">{node.name}</span>
          {node.children && (
            <span className="text-xs text-muted-foreground ml-auto">
              {node.children.length}
            </span>
          )}
        </button>
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
                selectedImageFileId={selectedImageFileId}
                onSelectImageFile={onSelectImageFile}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isStl = node.fileType === 'stl';
  const canView3D = isStl && Boolean(onOpenStl);
  const isImage = node.fileType === 'image' && Boolean(node.id);
  const isSelectedImage = isImage && node.id === selectedImageFileId;
  const canSelectImage = isImage && Boolean(onSelectImageFile);

  function selectImage() {
    if (canSelectImage && node.id) {
      onSelectImageFile!(node.id);
    }
  }

  return (
    <div
      role={canSelectImage ? 'button' : undefined}
      tabIndex={canSelectImage ? 0 : undefined}
      onClick={selectImage}
      onKeyDown={(event) => {
        if (!canSelectImage) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectImage();
        }
      }}
      className={cn(
        'flex items-center gap-1.5 py-1 px-2 rounded text-sm group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        canSelectImage ? 'cursor-pointer hover:bg-muted/60' : 'hover:bg-muted/40',
        isSelectedImage && 'bg-primary/10 text-primary hover:bg-primary/15',
      )}
      style={{ paddingLeft: `${paddingLeft + 8}px` }}
      aria-label={canSelectImage ? `Select image ${node.name}` : undefined}
      aria-current={isSelectedImage ? 'true' : undefined}
    >
      <FileIcon fileType={node.fileType} />
      <span
        className={cn(
          'truncate flex-1 min-w-0',
          isSelectedImage ? 'text-primary font-medium' : 'text-foreground',
        )}
      >
        {node.name}
      </span>
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
      {node.sizeBytes !== undefined && (
        <span className="text-xs text-muted-foreground flex-shrink-0 ml-2">
          {formatFileSize(node.sizeBytes)}
        </span>
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
  selectedImageFileId?: string | null;
  onSelectImageFile?: (fileId: string) => void;
}

export function FileTree({
  tree,
  modelId,
  onOpenStl,
  selectedImageFileId,
  onSelectImageFile,
}: FileTreeProps) {
  const totalFiles = countFiles(tree);

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
        <span className="text-sm font-semibold text-foreground">Files</span>
        <span className="text-xs text-muted-foreground">{totalFiles} files</span>
      </div>
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
              selectedImageFileId={selectedImageFileId}
              onSelectImageFile={onSelectImageFile}
              defaultExpanded={true}
            />
          ))
        )}
      </div>
    </div>
  );
}
