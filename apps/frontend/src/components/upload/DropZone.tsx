import { useCallback, useRef, useState } from 'react';
import { UploadCloud, FileArchive, X } from 'lucide-react';
import { uploadModel } from '../../api/models';
import { formatFileSize } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { UploadProgress } from './UploadProgress';

type UploadState =
  | { phase: 'idle' }
  | { phase: 'selected'; file: File }
  | { phase: 'uploading'; file: File; pct: number }
  | { phase: 'processing'; file: File; modelId: string }
  | { phase: 'error'; file: File; message: string };

export function DropZone() {
  const [state, setState] = useState<UploadState>({ phase: 'idle' });
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectFile = useCallback((file: File) => {
    if (!file.name.endsWith('.zip')) {
      setState({ phase: 'error', file, message: 'Only .zip files are supported.' });
      return;
    }
    setState({ phase: 'selected', file });
  }, []);

  const startUpload = useCallback(async (file: File) => {
    setState({ phase: 'uploading', file, pct: 0 });
    try {
      const { modelId } = await uploadModel(file, (pct) => {
        setState({ phase: 'uploading', file, pct });
      });
      setState({ phase: 'processing', file, modelId });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Upload failed. Please try again.';
      setState({ phase: 'error', file, message });
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) selectFile(file);
    },
    [selectFile]
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) selectFile(file);
    // reset so re-selecting the same file triggers onChange
    e.target.value = '';
  };

  const reset = () => {
    setState({ phase: 'idle' });
  };

  // Idle/drop zone
  if (state.phase === 'idle') {
    return (
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed p-16 cursor-pointer transition-colors',
          isDragging
            ? 'border-primary bg-primary/5'
            : 'border-border bg-muted/30 hover:border-primary/60 hover:bg-muted/50'
        )}
        role="button"
        tabIndex={0}
        aria-label="Upload zip file"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
      >
        <UploadCloud
          className={cn(
            'h-12 w-12 transition-colors',
            isDragging ? 'text-primary' : 'text-muted-foreground/60'
          )}
        />
        <div className="text-center space-y-1">
          <p className="text-base font-medium text-foreground">
            Drag &amp; drop a zip file here, or click to browse
          </p>
          <p className="text-sm text-muted-foreground">Only .zip archives are supported</p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          className="sr-only"
          onChange={handleInputChange}
          tabIndex={-1}
        />
      </div>
    );
  }

  // File selected — confirm before upload
  if (state.phase === 'selected') {
    return (
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="flex items-start gap-3">
          <FileArchive className="h-8 w-8 text-primary shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{state.file.name}</p>
            <p className="text-xs text-muted-foreground">{formatFileSize(state.file.size)}</p>
          </div>
          <button
            onClick={reset}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Remove selected file"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => startUpload(state.file)}>Upload</Button>
          <Button variant="outline" onClick={reset}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // Uploading
  if (state.phase === 'uploading') {
    return (
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="flex items-start gap-3">
          <FileArchive className="h-8 w-8 text-primary shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{state.file.name}</p>
            <p className="text-xs text-muted-foreground">{formatFileSize(state.file.size)}</p>
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Uploading...</span>
            <span className="tabular-nums text-xs text-muted-foreground">{state.pct}%</span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-200"
              style={{ width: `${state.pct}%` }}
            />
          </div>
        </div>
      </div>
    );
  }

  // Processing (upload done, job running)
  if (state.phase === 'processing') {
    return (
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="flex items-start gap-3">
          <FileArchive className="h-8 w-8 text-primary shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{state.file.name}</p>
            <p className="text-xs text-muted-foreground">Upload complete — processing job running</p>
          </div>
        </div>
        <UploadProgress modelId={state.modelId} />
        <Button variant="outline" size="sm" onClick={reset}>
          Upload another
        </Button>
      </div>
    );
  }

  // Error
  return (
    <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-6 space-y-3">
      <div className="flex items-start gap-3">
        <FileArchive className="h-8 w-8 text-destructive/60 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{state.file.name}</p>
          <p className="text-sm text-destructive mt-1">{state.message}</p>
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
