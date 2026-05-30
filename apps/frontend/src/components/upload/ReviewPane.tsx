import { Loader2, AlertCircle, Folder, FileCode2, File, Package } from 'lucide-react';
import type { ImportSession, DetectedFolderNode } from '@alexandria/shared';
import { BatchMetadataForm } from './BatchMetadataForm';
import { UploadProgress } from './UploadProgress';
import { Button } from '../ui/button';
import { formatFileSize } from '../../lib/format';

interface ReviewPaneProps {
  session: ImportSession;
  onCommitted: (modelId: string) => void;
  onDiscard: () => void;
  onRetry: () => void;
}

export function ReviewPane({ session, onCommitted, onDiscard, onRetry }: ReviewPaneProps) {
  if (session.status === 'scanning') {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-5">
        <div
          className="flex items-center justify-center rounded-2xl"
          style={{
            width: 64,
            height: 64,
            background: 'var(--ax-amber-tint)',
            color: 'var(--ax-amber-tint-fg)',
          }}
        >
          <Loader2 className="h-7 w-7 animate-spin" />
        </div>
        <div className="text-center">
          <h2
            className="text-xl font-bold"
            style={{ color: 'var(--ax-fg)' }}
          >
            Scanning archive…
          </h2>
          <p className="mt-1.5 text-[13px]" style={{ color: 'var(--ax-fg-muted)' }}>
            Extracting, detecting folder structure and metadata
          </p>
        </div>
      </div>
    );
  }

  if (session.status === 'error') {
    return (
      <div
        className="flex gap-4 rounded-xl p-8"
        style={{
          background: 'var(--ax-bg-elev)',
          border: '1px solid var(--ax-danger)',
        }}
      >
        <div
          className="flex items-center justify-center rounded-xl flex-shrink-0"
          style={{
            width: 48,
            height: 48,
            background: 'color-mix(in srgb, var(--ax-danger) 12%, transparent)',
            color: 'var(--ax-danger)',
          }}
        >
          <AlertCircle className="h-6 w-6" />
        </div>
        <div className="flex-1">
          <h2 className="text-[18px] font-semibold" style={{ color: 'var(--ax-fg)' }}>
            Couldn't process this archive
          </h2>
          <p className="mt-1.5 mb-4 text-[13px]" style={{ color: 'var(--ax-fg-muted)' }}>
            {session.error ?? 'An unknown error occurred during scanning.'}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry upload
            </Button>
            <Button variant="outline" size="sm" onClick={onDiscard}>
              Discard
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (session.status === 'committing' || session.status === 'committed') {
    const modelId = session.modelId;
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-5">
        <div
          className="flex items-center justify-center rounded-2xl"
          style={{
            width: 64,
            height: 64,
            background: 'var(--ax-teal-tint)',
            color: 'var(--ax-teal-tint-fg)',
          }}
        >
          <Package className="h-7 w-7" />
        </div>
        <div className="text-center max-w-sm">
          <h2 className="text-xl font-bold" style={{ color: 'var(--ax-fg)' }}>
            {session.status === 'committing' ? 'Importing…' : 'Imported!'}
          </h2>
          <p className="mt-1.5 text-[13px]" style={{ color: 'var(--ax-fg-muted)' }}>
            {session.status === 'committing'
              ? 'Your archive is being processed. This may take a moment.'
              : 'Archive committed. Processing the model now.'}
          </p>
        </div>
        {modelId && (
          <div className="w-full max-w-sm">
            <UploadProgress modelId={modelId} />
          </div>
        )}
      </div>
    );
  }

  // ready_for_review
  const { detected } = session;
  if (!detected) {
    return (
      <div className="py-12 text-center text-[13px]" style={{ color: 'var(--ax-fg-muted)' }}>
        Detected metadata unavailable. Try discarding and re-uploading.
      </div>
    );
  }

  return (
    <div
      className="grid gap-6"
      style={{ gridTemplateColumns: '1.4fr 1fr' }}
    >
      {/* Left: folder structure + counts */}
      <div>
        <div className="flex items-baseline justify-between mb-2.5">
          <h2 className="text-[16px] font-bold" style={{ color: 'var(--ax-fg)' }}>
            {detected.modelCount} model{detected.modelCount !== 1 ? 's' : ''} detected
          </h2>
          <span className="ax-mono text-[12px]" style={{ color: 'var(--ax-fg-muted)' }}>
            {detected.fileCount} files · {formatFileSize(detected.totalSizeBytes)}
          </span>
        </div>

        <h3
          className="text-[13px] font-semibold mb-2"
          style={{ color: 'var(--ax-fg)' }}
        >
          Detected folder structure
        </h3>
        <div
          className="ax-code rounded-xl p-3.5 text-[12px] leading-relaxed overflow-auto max-h-80"
          style={{
            background: 'var(--ax-bg-elev)',
            border: '1px solid var(--ax-border)',
            lineHeight: '1.7',
          }}
        >
          {detected.folderStructure.length === 0 ? (
            <span style={{ color: 'var(--ax-fg-muted)' }}>No folder structure detected</span>
          ) : (
            <FolderTree nodes={detected.folderStructure} depth={0} maxDepth={4} />
          )}
        </div>
      </div>

      {/* Right: batch metadata form */}
      <BatchMetadataForm
        sessionId={session.id}
        detected={detected}
        onCommitted={onCommitted}
      />
    </div>
  );
}

function FolderTree({
  nodes,
  depth,
  maxDepth,
}: {
  nodes: DetectedFolderNode[];
  depth: number;
  maxDepth: number;
}) {
  if (depth > maxDepth) {
    return (
      <div
        style={{ paddingLeft: depth * 16, color: 'var(--ax-fg-muted)' }}
        className="flex items-center gap-1.5"
      >
        <span>…</span>
      </div>
    );
  }

  return (
    <>
      {nodes.map((node, i) => (
        <div key={i}>
          <div
            style={{
              paddingLeft: depth * 16,
              color: node.type === 'folder' ? 'var(--ax-fg)' : 'var(--ax-fg-muted)',
            }}
            className="flex items-center gap-1.5"
          >
            {node.type === 'folder' ? (
              <Folder className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--ax-amber)' }} />
            ) : node.fileType === 'stl' ? (
              <FileCode2 className="w-3 h-3 flex-shrink-0" />
            ) : (
              <File className="w-3 h-3 flex-shrink-0" />
            )}
            <span>{node.name}</span>
          </div>
          {node.children && node.children.length > 0 && (
            <FolderTree nodes={node.children} depth={depth + 1} maxDepth={maxDepth} />
          )}
        </div>
      ))}
    </>
  );
}
