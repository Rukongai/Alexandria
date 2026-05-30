import { useCallback, useRef, useState } from 'react';
import { UploadCloud, FolderOpen } from 'lucide-react';
import { SUPPORTED_ARCHIVE_EXTENSIONS } from '@alexandria/shared';
import { useStartScan } from '../../hooks/use-import-sessions';
import { formatFileSize } from '../../lib/format';
import { cn } from '../../lib/utils';

interface FileUploadState {
  file: File;
  pct: number;
  error: string | null;
}

interface DropZoneProps {
  /** When true, render the compact "drop more" banner instead of the full drop zone */
  compact?: boolean;
  onBrowseFolder?: () => void;
}

export function DropZone({ compact = false, onBrowseFolder }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState<FileUploadState[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const startScan = useStartScan();

  const isValidArchive = (file: File) => {
    const lower = file.name.toLowerCase();
    return SUPPORTED_ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  };

  const enqueueFile = useCallback(
    (file: File) => {
      if (!isValidArchive(file)) return;

      const entry: FileUploadState = { file, pct: 0, error: null };
      setUploading((prev) => [...prev, entry]);

      startScan.mutate(
        {
          file,
          onProgress: (pct) => {
            setUploading((prev) =>
              prev.map((e) => (e.file === file ? { ...e, pct } : e))
            );
          },
        },
        {
          onError: (err) => {
            const msg = err instanceof Error ? err.message : 'Upload failed';
            setUploading((prev) =>
              prev.map((e) =>
                e.file === file ? { ...e, error: msg } : e
              )
            );
          },
          onSuccess: () => {
            // Remove from local uploading list once session exists in the queue
            setUploading((prev) => prev.filter((e) => e.file !== file));
          },
        }
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [startScan]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      Array.from(e.dataTransfer.files).forEach(enqueueFile);
    },
    [enqueueFile]
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    Array.from(e.target.files ?? []).forEach(enqueueFile);
    e.target.value = '';
  };

  if (compact) {
    return (
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={cn(
          'flex items-center gap-3.5 rounded-xl p-3.5 mx-7 mt-4 transition-colors',
          isDragging && 'ring-2 ring-[var(--ax-amber)]'
        )}
        style={{
          background: 'var(--ax-bg-elev)',
          border: '1px dashed var(--ax-border-strong)',
        }}
      >
        <div
          className="flex items-center justify-center rounded-xl flex-shrink-0"
          style={{
            width: 38,
            height: 38,
            background: 'var(--ax-amber-tint)',
            color: 'var(--ax-amber-tint-fg)',
          }}
        >
          <UploadCloud className="h-[18px] w-[18px]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold" style={{ color: 'var(--ax-fg)' }}>
            Drop more archives anywhere
          </p>
          <p className="text-[12px]" style={{ color: 'var(--ax-fg-muted)' }}>
            .zip, .rar, .7z, .tar.gz — multiple files OK
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="ax-chip hover:opacity-80 transition-opacity cursor-pointer"
          >
            Browse files
          </button>
          {onBrowseFolder && (
            <button
              type="button"
              onClick={onBrowseFolder}
              className="ax-chip hover:opacity-80 transition-opacity cursor-pointer flex items-center gap-1"
            >
              <FolderOpen className="w-3 h-3" />
              Server folder
            </button>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".zip,.rar,.7z,.tar.gz,.tgz"
          className="sr-only"
          onChange={handleInputChange}
          tabIndex={-1}
        />
      </div>
    );
  }

  // Full drop zone (when no sessions yet)
  return (
    <div className="space-y-3">
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed p-16 cursor-pointer transition-colors',
          isDragging
            ? 'border-[var(--ax-amber)] bg-[var(--ax-amber-tint)]'
            : 'border-[var(--ax-border-strong)] hover:border-[var(--ax-amber)] hover:bg-[var(--ax-bg-elev)]'
        )}
        role="button"
        tabIndex={0}
        aria-label="Upload archive files"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
      >
        <UploadCloud
          className="h-12 w-12 transition-colors"
          style={{ color: isDragging ? 'var(--ax-amber)' : 'var(--ax-fg-muted)' }}
        />
        <div className="text-center space-y-1">
          <p className="text-base font-semibold" style={{ color: 'var(--ax-fg)' }}>
            Drag &amp; drop archives here, or click to browse
          </p>
          <p className="text-sm" style={{ color: 'var(--ax-fg-muted)' }}>
            Supports .zip, .rar, .7z, .tar.gz — drop multiple files at once
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".zip,.rar,.7z,.tar.gz,.tgz,application/zip,application/x-rar-compressed,application/x-7z-compressed,application/x-tar"
          className="sr-only"
          onChange={handleInputChange}
          tabIndex={-1}
        />
      </div>

      {/* In-flight upload progress rows */}
      {uploading.length > 0 && (
        <div className="space-y-2">
          {uploading.map((entry, i) => (
            <UploadRow key={i} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function UploadRow({ entry }: { entry: FileUploadState }) {
  return (
    <div
      className="rounded-lg px-4 py-3 space-y-2"
      style={{
        background: 'var(--ax-bg-elev)',
        border: entry.error
          ? '1px solid var(--ax-danger)'
          : '1px solid var(--ax-border)',
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className="ax-code text-[12px] truncate"
          style={{ color: 'var(--ax-fg)' }}
        >
          {entry.file.name}
        </span>
        <span className="ax-mono text-[11px] flex-shrink-0" style={{ color: 'var(--ax-fg-muted)' }}>
          {formatFileSize(entry.file.size)}
        </span>
      </div>
      {entry.error ? (
        <p className="text-[11.5px]" style={{ color: 'var(--ax-danger)' }}>
          {entry.error}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <div
            className="flex-1 h-1.5 rounded-full overflow-hidden"
            style={{ background: 'var(--ax-bg-sunk)' }}
          >
            <div
              className="h-full rounded-full transition-all duration-200"
              style={{
                width: `${entry.pct}%`,
                background: 'var(--ax-amber)',
              }}
            />
          </div>
          <span className="ax-mono text-[11px] flex-shrink-0" style={{ color: 'var(--ax-fg-muted)' }}>
            {entry.pct}%
          </span>
        </div>
      )}
    </div>
  );
}
