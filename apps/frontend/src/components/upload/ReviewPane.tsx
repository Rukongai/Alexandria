import { useState } from 'react';
import {
  Loader2,
  AlertCircle,
  Folder,
  FileCode2,
  File,
  Package,
  PackageOpen,
  FilePlus2,
  Image as ImageIcon,
} from 'lucide-react';
import type {
  ImportSession,
  DetectedArchiveFile,
  DetectedFolderNode,
  DetectedPreviewImage,
} from '@alexandria/shared';
import { BatchMetadataForm } from './BatchMetadataForm';
import { UploadProgress } from './UploadProgress';
import { Button } from '../ui/button';
import { formatFileSize } from '../../lib/format';
import { isArchiveFileName } from '../../lib/model-files';
import { useExtractSessionArchive } from '../../hooks/use-import-sessions';
import { useToast } from '../../hooks/use-toast';

interface ReviewPaneProps {
  session: ImportSession;
  onCommitted: (modelId: string) => void;
  onDiscard: () => void;
  onRetry: () => void;
  isDiscarding?: boolean;
  onAddFiles?: () => void;
  isAddingFiles?: boolean;
  addFilesProgress?: number;
}

export function ReviewPane({
  session,
  onCommitted,
  onDiscard,
  onRetry,
  isDiscarding = false,
  onAddFiles,
  isAddingFiles = false,
  addFilesProgress = 0,
}: ReviewPaneProps) {
  const extractArchive = useExtractSessionArchive();
  const { toast } = useToast();

  async function handleExtractArchive(relativePath: string) {
    try {
      await extractArchive.mutateAsync({ id: session.id, relativePath });
      toast({ title: 'Archive extracted' });
    } catch (error) {
      toast({
        title: 'Archive extraction failed',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  }

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
            <Button variant="outline" size="sm" onClick={onRetry} disabled={isDiscarding}>
              Retry upload
            </Button>
            <Button variant="outline" size="sm" onClick={onDiscard} disabled={isDiscarding}>
              {isDiscarding && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              {isDiscarding ? 'Discarding' : 'Discard'}
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
            {session.status === 'committing'
              ? 'Saving model to library…'
              : 'Imported!'}
          </h2>
          <p className="mt-1.5 text-[13px]" style={{ color: 'var(--ax-fg-muted)' }}>
            {session.status === 'committing'
              ? 'Alexandria is finishing this import on the server.'
              : 'The model has been saved to your library.'}
          </p>
        </div>
        {modelId && (
          <div className="w-full max-w-sm">
            <UploadProgress
              modelId={modelId}
              commitProgress={session.commitProgress}
            />
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
      className="grid min-w-0 gap-6"
      data-testid="upload-review-grid"
      style={{
        gridTemplateColumns: 'minmax(0, 1.4fr) minmax(320px, 1fr)',
      }}
    >
      {/* Left: folder structure + counts */}
      <div className="min-w-0">
        <div className="mb-2.5 flex min-w-0 items-center justify-between gap-3">
          <h2 className="text-[16px] font-bold" style={{ color: 'var(--ax-fg)' }}>
            {detected.modelCount} model{detected.modelCount !== 1 ? 's' : ''} detected
          </h2>
          <div className="flex flex-shrink-0 items-center gap-2">
            <span className="ax-mono text-[12px]" style={{ color: 'var(--ax-fg-muted)' }}>
              {detected.fileCount} files · {formatFileSize(detected.totalSizeBytes)}
            </span>
            {onAddFiles && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onAddFiles}
                disabled={isAddingFiles}
                className="h-7 gap-1.5 px-2 text-[11px]"
              >
                {isAddingFiles ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FilePlus2 className="h-3.5 w-3.5" />
                )}
                {isAddingFiles ? `Uploading ${addFilesProgress}%` : 'Add files'}
              </Button>
            )}
          </div>
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
            <FolderTree nodes={detected.folderStructure} depth={0} pathPrefix={[]} />
          )}
        </div>

        {(detected.archives?.length ?? 0) > 0 && (
          <NestedArchiveList
            archives={detected.archives ?? []}
            onExtract={(relativePath) => void handleExtractArchive(relativePath)}
            extractingPath={extractArchive.isPending ? extractArchive.variables?.relativePath : undefined}
          />
        )}

        {(detected.previewImages?.length ?? 0) > 0 && (
          <UploadImagePreviews
            key={session.id}
            sessionId={session.id}
            images={detected.previewImages ?? []}
          />
        )}
      </div>

      {/* Right: batch metadata form */}
      <BatchMetadataForm
        sessionId={session.id}
        originalFilename={session.originalFilename}
        detected={detected}
        onCommitted={onCommitted}
      />
    </div>
  );
}

function previewImageUrl(sessionId: string, relativePath: string): string {
  return `/api/models/import-sessions/${sessionId}/preview/${relativePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

function UploadImagePreviews({
  sessionId,
  images,
}: {
  sessionId: string;
  images: DetectedPreviewImage[];
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = images[Math.min(selectedIndex, images.length - 1)];

  if (!selected) return null;

  return (
    <div className="mt-5 min-w-0 max-w-full">
      <div className="flex items-center justify-between mb-2.5">
        <h3 className="text-[13px] font-semibold" style={{ color: 'var(--ax-fg)' }}>
          Image previews
        </h3>
        <span className="ax-mono text-[12px]" style={{ color: 'var(--ax-fg-muted)' }}>
          {images.length} image{images.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div
        className="min-w-0 max-w-full overflow-hidden rounded-xl"
        style={{
          background: 'var(--ax-bg-elev)',
          border: '1px solid var(--ax-border)',
        }}
      >
        <div className="relative aspect-[16/9] min-w-0 overflow-hidden bg-black/5">
          <img
            src={previewImageUrl(sessionId, selected.relativePath)}
            alt={selected.filename}
            className="h-full w-full object-contain"
          />
          <div
            className="absolute bottom-0 left-0 right-0 flex items-center gap-2 px-3 py-2 text-[12px]"
            style={{
              background: 'color-mix(in srgb, var(--ax-bg-elev) 88%, transparent)',
              color: 'var(--ax-fg)',
            }}
          >
            <ImageIcon className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="truncate">{selected.relativePath}</span>
          </div>
        </div>

        {images.length > 1 && (
          <div className="ax-scroll flex min-w-0 max-w-full gap-2 overflow-x-auto p-2">
            {images.map((image, index) => (
              <button
                key={image.relativePath}
                type="button"
                onClick={() => setSelectedIndex(index)}
                aria-label={`Preview ${image.filename}`}
                aria-pressed={index === selectedIndex}
                className="h-14 w-20 flex-shrink-0 overflow-hidden rounded-md"
                style={{
                  border: index === selectedIndex
                    ? '2px solid var(--ax-amber)'
                    : '1px solid var(--ax-border)',
                  background: 'var(--ax-bg)',
                }}
              >
                <img
                  src={previewImageUrl(sessionId, image.relativePath)}
                  alt=""
                  className="h-full w-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FolderTree({
  nodes,
  depth,
  pathPrefix,
}: {
  nodes: DetectedFolderNode[];
  depth: number;
  pathPrefix: string[];
}) {
  return (
    <>
      {nodes.map((node, i) => {
        const segments = [...pathPrefix, node.name];
        const isArchive = node.type === 'file' && isArchiveFileName(node.name);
        const relativePath = segments.join('/');

        return (
          <div key={`${relativePath}-${i}`}>
            <div
              style={{
                paddingLeft: depth * 16,
                color: node.type === 'folder' ? 'var(--ax-fg)' : 'var(--ax-fg-muted)',
              }}
              className="group flex min-w-0 items-center gap-1.5"
            >
              {node.type === 'folder' ? (
                <Folder className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--ax-amber)' }} />
              ) : isArchive ? (
                <Package className="w-3 h-3 flex-shrink-0" />
              ) : node.fileType === 'stl' ? (
                <FileCode2 className="w-3 h-3 flex-shrink-0" />
              ) : (
                <File className="w-3 h-3 flex-shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
            </div>
            {node.children && node.children.length > 0 && (
              <FolderTree
                nodes={node.children}
                depth={depth + 1}
                pathPrefix={segments}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function NestedArchiveList({
  archives,
  onExtract,
  extractingPath,
}: {
  archives: DetectedArchiveFile[];
  onExtract: (relativePath: string) => void;
  extractingPath?: string;
}) {
  return (
    <div className="mt-5">
      <div className="flex items-center justify-between mb-2.5">
        <h3 className="text-[13px] font-semibold" style={{ color: 'var(--ax-fg)' }}>
          Nested archives
        </h3>
        <span className="ax-mono text-[12px]" style={{ color: 'var(--ax-fg-muted)' }}>
          {archives.length}
        </span>
      </div>
      <div
        className="overflow-hidden rounded-lg"
        style={{ background: 'var(--ax-bg-elev)', border: '1px solid var(--ax-border)' }}
      >
        {archives.map((archive) => {
          const isExtracting = extractingPath === archive.relativePath;
          return (
            <div
              key={archive.relativePath}
              className="flex min-w-0 items-center gap-2 border-b px-3 py-2 last:border-b-0"
              style={{ borderColor: 'var(--ax-border)' }}
            >
              <Package className="h-3.5 w-3.5 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px]" style={{ color: 'var(--ax-fg)' }}>
                  {archive.relativePath}
                </div>
                <div className="ax-mono text-[10.5px]" style={{ color: 'var(--ax-fg-muted)' }}>
                  {formatFileSize(archive.sizeBytes)}
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onExtract(archive.relativePath)}
                disabled={Boolean(extractingPath)}
                aria-label={`Extract ${archive.filename}`}
                title={`Extract ${archive.filename}`}
                className="h-7 gap-1.5 px-2 text-[11px]"
              >
                {isExtracting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <PackageOpen className="h-3.5 w-3.5" />
                )}
                Extract
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
