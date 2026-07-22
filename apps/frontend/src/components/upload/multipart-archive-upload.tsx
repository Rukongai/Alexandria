import { useRef, useState } from 'react';
import {
  Archive,
  Files,
  Loader2,
  RotateCcw,
  UploadCloud,
  X,
} from 'lucide-react';
import { SUPPORTED_ARCHIVE_EXTENSIONS, type MultipartArchiveMode } from '@alexandria/shared';
import { useStartMultipartScan } from '../../hooks/use-import-sessions';
import { formatFileSize } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

const MIN_FILES = 2;
const MAX_FILES = 100;
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;
const SPLIT_ARCHIVE_ACCEPT = [
  '.zip',
  '.rar',
  ...Array.from({ length: 99 }, (_, index) => `.z${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 999 }, (_, index) => `.${String(index + 1).padStart(3, '0')}`),
].join(',');

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function isCombineArchive(filename: string): boolean {
  const lower = filename.toLowerCase();
  return SUPPORTED_ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function isModernSplitRar(filename: string): boolean {
  return /\.part\d+\.rar$/i.test(filename);
}

function missingPartMessage(indices: number[], digits: number): string | null {
  const unique = new Set(indices);
  if (unique.size !== indices.length) return 'The split archive contains duplicate part numbers.';

  const max = Math.max(...indices);
  for (let index = 1; index <= max; index++) {
    if (!unique.has(index)) {
      return `Split archive part ${String(index).padStart(digits, '0')} is missing.`;
    }
  }
  return null;
}

function validateNumberedZipSet(names: string[]): string | null | undefined {
  const matches = names.map((name) =>
    name.match(/^(.+\.zip)\.(00[1-9]|0[1-9]\d|[1-9]\d{2})$/));
  if (matches.every((match) => !match)) return undefined;
  if (matches.some((match) => !match)) {
    return 'Choose exactly one split archive set. Do not mix split ZIP and split RAR naming schemes.';
  }

  const numberedMatches = matches as RegExpMatchArray[];
  const base = numberedMatches[0][1];
  if (numberedMatches.some((match) => match[1] !== base)) {
    return 'All numbered ZIP parts must have the same base filename.';
  }
  return missingPartMessage(numberedMatches.map((match) => Number(match[2])), 3);
}

function validateRarSet(names: string[]): string | null | undefined {
  const matches = names.map((name) => name.match(/^(.+)\.part(\d+)\.rar$/));
  if (matches.every((match) => !match)) return undefined;
  if (matches.some((match) => !match)) {
    return 'Choose exactly one split archive set. Do not mix split ZIP and split RAR naming schemes.';
  }

  const rarMatches = matches as RegExpMatchArray[];
  const base = rarMatches[0][1];
  if (rarMatches.some((match) => match[1] !== base)) {
    return 'All split RAR parts must have the same base filename.';
  }

  const indices = rarMatches.map((match) => Number(match[2]));
  if (indices.some((index) => index < 1 || index > MAX_FILES)) {
    return `Split RAR part numbers must run from 1 through ${MAX_FILES}.`;
  }

  const unique = new Set(indices);
  if (unique.size !== indices.length) {
    return 'The split archive contains duplicate part numbers.';
  }

  const partOne = rarMatches.find((match) => Number(match[2]) === 1);
  if (!partOne) return missingPartMessage(indices, rarMatches[0][2].length);

  const partNumberWidth = partOne[2].length;
  const hasInconsistentPadding = rarMatches.some((match) => (
    match[2] !== String(Number(match[2])).padStart(partNumberWidth, '0')
  ));
  if (hasInconsistentPadding) {
    return 'All split RAR part numbers must use consistent zero-padding.';
  }

  return missingPartMessage(indices, partNumberWidth);
}

function validateClassicZipSet(names: string[]): string | null {
  const terminalZips = names.filter((name) => name.endsWith('.zip'));
  const classicParts = names
    .filter((name) => !name.endsWith('.zip'))
    .map((name) => name.match(/^(.*)\.z(0[1-9]|[1-9]\d)$/));
  if (terminalZips.length !== 1 || classicParts.some((match) => !match)) {
    return 'Choose one complete split archive: .z01 … .zip, .zip.001 …, or .part1.rar …';
  }

  const matches = classicParts as RegExpMatchArray[];
  const terminalBase = terminalZips[0].slice(0, -4);
  if (matches.some((match) => match[1] !== terminalBase)) {
    return 'All classic ZIP parts must have the same base filename.';
  }
  return missingPartMessage(matches.map((match) => Number(match[2])), 2);
}

export function validateMultipartSelection(
  files: File[],
  mode: MultipartArchiveMode,
): string | null {
  if (files.length < MIN_FILES) return 'Choose at least 2 files for one grouped upload.';
  if (files.length > MAX_FILES) return 'Choose no more than 100 files.';

  const empty = files.find((file) => file.size <= 0);
  if (empty) return `${empty.name} is empty.`;
  const oversized = files.find((file) => file.size > MAX_FILE_SIZE);
  if (oversized) return `${oversized.name} is larger than the 5 GB per-file limit.`;
  const longFilename = files.find((file) => file.name.length > 512);
  if (longFilename) return `${longFilename.name.slice(0, 40)}… has a filename longer than 512 characters.`;

  if (mode === 'combine') {
    const splitRarPart = files.find((file) => isModernSplitRar(file.name));
    if (splitRarPart) {
      return `${splitRarPart.name} is part of a split RAR. Choose Split archive mode and select every part.`;
    }

    const unsupported = files.find((file) => !isCombineArchive(file.name));
    return unsupported
      ? `${unsupported.name} is not a supported archive (.zip, .rar, .7z, .tar.gz, or .tgz).`
      : null;
  }

  const names = files.map((file) => file.name.toLowerCase());
  const numberedZipResult = validateNumberedZipSet(names);
  if (numberedZipResult !== undefined) return numberedZipResult;

  const rarResult = validateRarSet(names);
  if (rarResult !== undefined) return rarResult;

  return validateClassicZipSet(names);
}

interface MultipartArchiveUploadProps {
  onSessionCreated: (sessionId: string) => void;
}

export function MultipartArchiveUpload({ onSessionCreated }: MultipartArchiveUploadProps) {
  const [mode, setMode] = useState<MultipartArchiveMode>('combine');
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const startMultipartScan = useStartMultipartScan();
  const isUploading = startMultipartScan.isPending;
  const validationError = validateMultipartSelection(files, mode);
  const selectedBytes = files.reduce((sum, file) => sum + file.size, 0);

  const addFiles = (selected: File[]) => {
    if (isUploading || selected.length === 0) return;
    setUploadError(null);
    setFiles((current) => [...current, ...selected]);
  };

  const removeFile = (target: File) => {
    if (isUploading) return;
    setUploadError(null);
    setFiles((current) => current.filter((file) => file !== target));
  };

  const clearSelection = () => {
    setFiles([]);
    setProgress(0);
    setUploadError(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const reset = () => {
    if (!isUploading) clearSelection();
  };

  const submit = async () => {
    if (validationError || isUploading) return;
    setProgress(0);
    setUploadError(null);
    try {
      const result = await startMultipartScan.mutateAsync({
        files,
        mode,
        onProgress: setProgress,
      });
      clearSelection();
      onSessionCreated(result.sessionId);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Multipart upload failed.');
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-7 py-6 space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-bold" style={{ color: 'var(--ax-fg)' }}>
          Create one model from several files
        </h1>
        <p className="text-[13px] leading-5" style={{ color: 'var(--ax-fg-muted)' }}>
          Group independent archives or upload every part of one split archive. This creates one
          model in one review session. Ordinary multi-select under Archive upload still
          creates a separate model and session for each archive.
        </p>
      </div>

      <fieldset disabled={isUploading} className="space-y-3">
        <legend className="text-[13px] font-semibold" style={{ color: 'var(--ax-fg)' }}>
          How should Alexandria treat these files?
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <ModeChoice
            checked={mode === 'combine'}
            icon={Archive}
            title="Combine archives"
            description="Several complete archives become one model, extracted into separate archive-named folders."
            onSelect={() => { setMode('combine'); setUploadError(null); }}
          />
          <ModeChoice
            checked={mode === 'split'}
            icon={Files}
            title="Split archive"
            description="All parts of one split ZIP or RAR are assembled and extracted together. No part can be missing."
            onSelect={() => { setMode('split'); setUploadError(null); }}
          />
        </div>
      </fieldset>

      <div className="space-y-3">
        <div
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            addFiles(Array.from(event.dataTransfer.files));
          }}
          onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onClick={() => !isUploading && inputRef.current?.click()}
          onKeyDown={(event) => {
            if (!isUploading && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          role="button"
          tabIndex={isUploading ? -1 : 0}
          aria-label="Choose files for multipart archive"
          aria-disabled={isUploading}
          className={cn(
            'flex items-center gap-4 rounded-xl border-2 border-dashed px-5 py-6 transition-colors',
            isUploading ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
            isDragging
              ? 'border-[var(--ax-amber)] bg-[var(--ax-amber-tint)]'
              : 'border-[var(--ax-border-strong)] hover:border-[var(--ax-amber)] hover:bg-[var(--ax-bg-elev)]',
          )}
        >
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
            style={{ background: 'var(--ax-amber-tint)', color: 'var(--ax-amber-tint-fg)' }}
          >
            <UploadCloud className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold" style={{ color: 'var(--ax-fg)' }}>
              Drop all files here, or browse
            </p>
            <p className="mt-0.5 text-[12px]" style={{ color: 'var(--ax-fg-muted)' }}>
              {mode === 'combine'
                ? 'Choose 2–100 complete .zip, .rar, .7z, .tar.gz, or .tgz archives.'
                : 'Choose one complete .z01 … .zip, .zip.001 …, or .part1.rar … set.'}
            </p>
          </div>
          <span className="ax-chip shrink-0">Browse files</span>
          <input
            ref={inputRef}
            type="file"
            multiple
            aria-label="Select multipart archive files"
            accept={mode === 'combine' ? SUPPORTED_ARCHIVE_EXTENSIONS.join(',') : SPLIT_ARCHIVE_ACCEPT}
            className="sr-only"
            disabled={isUploading}
            onChange={(event) => {
              addFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = '';
            }}
            tabIndex={-1}
          />
        </div>

        {files.length > 0 && (
          <section
            className="overflow-hidden rounded-xl"
            style={{ border: '1px solid var(--ax-border)', background: 'var(--ax-bg-elev)' }}
            aria-labelledby="multipart-files-heading"
          >
            <div
              className="flex items-center justify-between gap-3 px-4 py-3"
              style={{ borderBottom: '1px solid var(--ax-border)' }}
            >
              <div>
                <h2 id="multipart-files-heading" className="text-[13px] font-semibold">
                  Selected files
                </h2>
                <p className="text-[11.5px]" style={{ color: 'var(--ax-fg-muted)' }}>
                  {files.length} of {MAX_FILES} · {formatFileSize(selectedBytes)} total
                </p>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={isUploading}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Reset
              </Button>
            </div>
            <ul className="max-h-64 divide-y divide-[var(--ax-border)] overflow-y-auto ax-scroll">
              {files.map((file, index) => (
                <li key={`${fileKey(file)}:${index}`} className="flex items-center gap-3 px-4 py-2.5">
                  <Archive className="h-4 w-4 shrink-0" style={{ color: 'var(--ax-fg-muted)' }} />
                  <span className="ax-code min-w-0 flex-1 truncate text-[12px]">{file.name}</span>
                  <span className="ax-mono shrink-0 text-[11px]" style={{ color: 'var(--ax-fg-muted)' }}>
                    {formatFileSize(file.size)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => removeFile(file)}
                    disabled={isUploading}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {files.length > 0 && validationError && (
          <p role="alert" className="text-[12px]" style={{ color: 'var(--ax-danger)' }}>
            {validationError}
          </p>
        )}
        {uploadError && (
          <p role="alert" className="text-[12px]" style={{ color: 'var(--ax-danger)' }}>
            {uploadError}
          </p>
        )}
      </div>

      {isUploading && (
        <div className="space-y-2" aria-live="polite">
          <div className="flex items-center justify-between text-[12px]">
            <span className="flex items-center gap-2" style={{ color: 'var(--ax-fg-muted)' }}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Uploading {files.length} files as one group…
            </span>
            <span className="ax-mono">{progress}%</span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full"
            style={{ background: 'var(--ax-bg-sunk)' }}
            role="progressbar"
            aria-label="Multipart archive upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div
              className="h-full rounded-full transition-all duration-200"
              style={{ width: `${progress}%`, background: 'var(--ax-amber)' }}
            />
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={Boolean(validationError) || isUploading}
        >
          {isUploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}
          Upload as one model
        </Button>
      </div>
    </div>
  );
}

interface ModeChoiceProps {
  checked: boolean;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  onSelect: () => void;
}

function ModeChoice({ checked, icon: Icon, title, description, onSelect }: ModeChoiceProps) {
  return (
    <label
      className={cn(
        'flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors',
        checked
          ? 'border-[var(--ax-amber)] bg-[var(--ax-amber-tint)]'
          : 'border-[var(--ax-border)] bg-[var(--ax-bg-elev)] hover:border-[var(--ax-border-strong)]',
      )}
    >
      <input
        type="radio"
        name="multipart-mode"
        checked={checked}
        onChange={onSelect}
        className="mt-1 h-3.5 w-3.5 accent-[var(--ax-amber)]"
      />
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        <span className="block text-[13px] font-semibold">{title}</span>
        <span className="mt-1 block text-[12px] leading-4" style={{ color: 'var(--ax-fg-muted)' }}>
          {description}
        </span>
      </span>
    </label>
  );
}
