import { useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { UploadCloud, FileArchive, X, AlertCircle } from 'lucide-react';
import { SUPPORTED_ARCHIVE_EXTENSIONS } from '@alexandria/shared';
import type { Library, MetadataFieldDetail } from '@alexandria/shared';
import { uploadModel } from '../../api/models';
import { getLibraries } from '../../api/libraries';
import { getFields } from '../../api/metadata';
import { formatFileSize } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { UploadProgress } from './UploadProgress';

type UploadState =
  | { phase: 'loading' }
  | { phase: 'no_library' }
  | { phase: 'idle'; selectedLibraryId: string; metadataValues: Record<string, string> }
  | { phase: 'selected'; file: File; selectedLibraryId: string; metadataValues: Record<string, string> }
  | { phase: 'uploading'; file: File; pct: number; selectedLibraryId: string; metadataValues: Record<string, string> }
  | { phase: 'processing'; file: File; modelId: string }
  | { phase: 'error'; file?: File; message: string; selectedLibraryId: string; metadataValues: Record<string, string> };

function extractMetadataSlugs(template: string): string[] {
  return [...template.matchAll(/\{metadata\.([a-z0-9_-]+)\}/g)].map(m => m[1]);
}

export function DropZone() {
  const [state, setState] = useState<UploadState>({ phase: 'loading' });
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: libraries, isLoading: librariesLoading } = useQuery<Library[]>({
    queryKey: ['libraries'],
    queryFn: () => getLibraries().then(r => r.data),
    staleTime: 60_000,
  });

  const { data: allFields = [] } = useQuery<MetadataFieldDetail[]>({
    queryKey: ['metadata-fields'],
    queryFn: getFields,
    staleTime: 60_000,
  });

  // Transition from loading once libraries arrive
  if (state.phase === 'loading' && !librariesLoading && libraries !== undefined) {
    if (libraries.length === 0) {
      setState({ phase: 'no_library' });
    } else {
      setState({ phase: 'idle', selectedLibraryId: '', metadataValues: {} });
    }
  }

  const selectedLibraryId =
    state.phase !== 'loading' && state.phase !== 'no_library' && state.phase !== 'processing'
      ? state.selectedLibraryId
      : '';

  const metadataValues =
    state.phase !== 'loading' && state.phase !== 'no_library' && state.phase !== 'processing'
      ? state.metadataValues
      : {};

  const selectedLibrary = libraries?.find(l => l.id === selectedLibraryId) ?? null;
  const requiredSlugs = selectedLibrary ? extractMetadataSlugs(selectedLibrary.pathTemplate) : [];

  const allMetadataFilled =
    selectedLibraryId !== '' &&
    requiredSlugs.every(slug => (metadataValues[slug] ?? '').trim().length > 0);

  const hasFile = state.phase === 'selected' || state.phase === 'error';
  const file = (state.phase === 'selected' || (state.phase === 'error' && state.file)) ? (state as { file: File }).file : null;

  const canUpload = allMetadataFilled && file !== null && state.phase === 'selected';

  const handleLibraryChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    setState(prev => {
      if (prev.phase === 'loading' || prev.phase === 'no_library' || prev.phase === 'processing') return prev;
      return { ...prev, selectedLibraryId: id, metadataValues: {} };
    });
  }, []);

  const handleMetadataChange = useCallback((slug: string, value: string) => {
    setState(prev => {
      if (prev.phase === 'loading' || prev.phase === 'no_library' || prev.phase === 'processing') return prev;
      return { ...prev, metadataValues: { ...prev.metadataValues, [slug]: value } };
    });
  }, []);

  const selectFile = useCallback((f: File) => {
    const lower = f.name.toLowerCase();
    if (!SUPPORTED_ARCHIVE_EXTENSIONS.some(ext => lower.endsWith(ext))) {
      setState(prev => {
        if (prev.phase === 'loading' || prev.phase === 'no_library' || prev.phase === 'processing') return prev;
        return {
          phase: 'error',
          file: f,
          message: 'Only .zip, .rar, .7z, and .tar.gz archives are supported.',
          selectedLibraryId: prev.selectedLibraryId,
          metadataValues: prev.metadataValues,
        };
      });
      return;
    }
    setState(prev => {
      if (prev.phase === 'loading' || prev.phase === 'no_library' || prev.phase === 'processing') return prev;
      return { phase: 'selected', file: f, selectedLibraryId: prev.selectedLibraryId, metadataValues: prev.metadataValues };
    });
  }, []);

  const clearFile = useCallback(() => {
    setState(prev => {
      if (prev.phase === 'loading' || prev.phase === 'no_library' || prev.phase === 'processing') return prev;
      return { phase: 'idle', selectedLibraryId: prev.selectedLibraryId, metadataValues: prev.metadataValues };
    });
  }, []);

  const startUpload = useCallback(async (f: File, libId: string, metaValues: Record<string, string>) => {
    const filteredMeta: Record<string, string> = {};
    for (const [k, v] of Object.entries(metaValues)) {
      if (v.trim().length > 0) filteredMeta[k] = v;
    }
    setState({ phase: 'uploading', file: f, pct: 0, selectedLibraryId: libId, metadataValues: metaValues });
    try {
      const { modelId } = await uploadModel(f, libId, filteredMeta, (pct) => {
        setState(prev => prev.phase === 'uploading' ? { ...prev, pct } : prev);
      });
      setState({ phase: 'processing', file: f, modelId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Upload failed. Please try again.';
      setState({ phase: 'error', file: f, message, selectedLibraryId: libId, metadataValues: metaValues });
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) selectFile(f);
  }, [selectFile]);

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = () => setIsDragging(false);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) selectFile(f);
    e.target.value = '';
  };

  const reset = () => {
    setState({ phase: 'idle', selectedLibraryId: selectedLibraryId, metadataValues: {} });
  };

  // Loading state
  if (state.phase === 'loading') {
    return (
      <div className="rounded-xl border bg-muted/30 p-12 flex items-center justify-center">
        <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  // No libraries — blocking gate
  if (state.phase === 'no_library') {
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-50 dark:bg-amber-950/20 p-6 flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
        <div className="space-y-2">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">No libraries configured</p>
          <p className="text-sm text-amber-700 dark:text-amber-400">
            You need to create a library before uploading models.
          </p>
          <Link
            to="/libraries"
            className="inline-block text-sm font-medium text-primary hover:underline"
          >
            Go to Libraries
          </Link>
        </div>
      </div>
    );
  }

  // Processing
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
        <Button variant="outline" size="sm" onClick={() => setState({ phase: 'idle', selectedLibraryId: selectedLibraryId, metadataValues: {} })}>
          Upload another
        </Button>
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

  // idle, selected, error — main form UI
  const currentFile = state.phase === 'selected' ? state.file : state.phase === 'error' ? state.file : undefined;

  return (
    <div className="space-y-4">
      {/* Library selector */}
      <div className="space-y-1.5">
        <Label htmlFor="library-select">Library</Label>
        <Select
          id="library-select"
          value={selectedLibraryId}
          onChange={handleLibraryChange}
          disabled={false}
        >
          <option value="" disabled>Select a library</option>
          {(libraries ?? []).map(lib => (
            <option key={lib.id} value={lib.id}>{lib.name}</option>
          ))}
        </Select>
      </div>

      {/* Required metadata fields */}
      {selectedLibraryId && requiredSlugs.map(slug => {
        const field = allFields.find(f => f.slug === slug);
        const displayName = field?.name ?? slug;
        return (
          <div key={slug} className="space-y-1.5">
            <Label htmlFor={`meta-${slug}`}>{displayName}</Label>
            <Input
              id={`meta-${slug}`}
              value={metadataValues[slug] ?? ''}
              onChange={e => handleMetadataChange(slug, e.target.value)}
              placeholder={`Enter ${displayName}`}
            />
          </div>
        );
      })}

      {/* Error message (validation) */}
      {state.phase === 'error' && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{state.message}</span>
        </div>
      )}

      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed p-12 cursor-pointer transition-colors',
          isDragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/30 hover:border-primary/60 hover:bg-muted/50'
        )}
        role="button"
        tabIndex={0}
        aria-label="Upload archive file"
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
      >
        {currentFile ? (
          <div className="flex items-center gap-3">
            <FileArchive className="h-6 w-6 text-primary" />
            <div>
              <p className="text-sm font-medium">{currentFile.name}</p>
              <p className="text-xs text-muted-foreground">{formatFileSize(currentFile.size)}</p>
            </div>
            <button
              onClick={e => { e.stopPropagation(); clearFile(); }}
              aria-label="Remove file"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <>
            <UploadCloud className={cn('h-10 w-10', isDragging ? 'text-primary' : 'text-muted-foreground/60')} />
            <p className="text-sm text-muted-foreground">Drag &amp; drop or click to select archive</p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          onChange={handleInputChange}
          tabIndex={-1}
          accept=".zip,.rar,.7z,.tar.gz,.tgz"
        />
      </div>

      <div className="flex gap-2">
        <Button
          onClick={() => {
            if (file) startUpload(file, selectedLibraryId, metadataValues);
          }}
          disabled={!canUpload}
        >
          Upload
        </Button>
        {hasFile && (
          <Button variant="outline" onClick={reset}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
