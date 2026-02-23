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

interface FileNodeProps {
  node: FileTreeNode;
  depth: number;
  defaultExpanded?: boolean;
}

function FileIcon({ fileType }: { fileType?: FileType }) {
  switch (fileType) {
    case 'stl':
      return <Box className="h-4 w-4 text-amber-600 flex-shrink-0" />;
    case 'image':
      return <Image className="h-4 w-4 text-blue-500 flex-shrink-0" />;
    case 'document':
      return <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
    default:
      return <File className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
  }
}

function FileNode({ node, depth, defaultExpanded = false }: FileNodeProps) {
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const paddingLeft = depth * 16;

  if (node.type === 'directory') {
    return (
      <div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-1.5 py-1 px-2 rounded hover:bg-muted/60 text-sm text-left group"
          style={{ paddingLeft: `${paddingLeft + 8}px` }}
        >
          {expanded ? (
            <FolderOpen className="h-4 w-4 text-amber-500 flex-shrink-0" />
          ) : (
            <Folder className="h-4 w-4 text-amber-500 flex-shrink-0" />
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
              <FileNode key={`${child.name}-${i}`} node={child} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-1.5 py-1 px-2 rounded hover:bg-muted/40 text-sm"
      style={{ paddingLeft: `${paddingLeft + 8}px` }}
    >
      <FileIcon fileType={node.fileType} />
      <span className="truncate text-foreground flex-1 min-w-0">{node.name}</span>
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
}

export function FileTree({ tree }: FileTreeProps) {
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
              defaultExpanded={true}
            />
          ))
        )}
      </div>
    </div>
  );
}
