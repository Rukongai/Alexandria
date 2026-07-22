import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Loader2, CheckCircle2, AlertCircle, ArrowRight } from 'lucide-react';
import { getModelStatus } from '../../api/models';
import type { ImportCommitPhase, ImportCommitProgress } from '@alexandria/shared';
import { useLibraryPath } from '../../hooks/use-libraries';
import { formatFileSize } from '../../lib/format';

interface UploadProgressProps {
  modelId: string;
  commitProgress?: ImportCommitProgress | null;
}

export function commitPhaseLabel(phase: ImportCommitPhase): string {
  switch (phase) {
    case 'queued':
    case 'storing_files':
      return 'Saving files to library storage';
    case 'saving_records':
      return 'Recording files';
    case 'generating_thumbnails':
      return 'Generating previews';
    case 'applying_metadata':
      return 'Applying details';
    case 'complete':
      return 'Finishing';
  }
}

export function commitProgressValueText(progress: ImportCommitProgress): string {
  const parts = [
    commitPhaseLabel(progress.phase),
    `${progress.percent}%`,
    `${formatFileSize(progress.completedBytes)} of ${formatFileSize(progress.totalBytes)}`,
    `${progress.completedFiles} of ${progress.totalFiles} files`,
  ];
  if (progress.currentFilename) parts.push(`Current file: ${progress.currentFilename}`);
  return parts.join('. ');
}

export function UploadProgress({ modelId, commitProgress = null }: UploadProgressProps) {
  const libPath = useLibraryPath();
  const { data: status, error } = useQuery({
    queryKey: ['model-status', modelId],
    queryFn: () => getModelStatus(modelId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 2000;
      if (data.status === 'ready' || data.status === 'error') return false;
      return 2000;
    },
    staleTime: 0,
  });

  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Could not fetch processing status.</span>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none shrink-0" />
        <span>Loading status...</span>
      </div>
    );
  }

  if (status.status === 'error') {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{status.error ?? 'Processing failed with an unknown error.'}</span>
        </div>
        <Link
          to={libPath(`/models/${modelId}`)}
          className="text-sm text-primary hover:underline inline-flex items-center gap-1"
        >
          View model anyway <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    );
  }

  const commitIsActive = commitProgress !== null && commitProgress.phase !== 'complete';

  if (status.status === 'ready' && !commitIsActive) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--ax-success)' }}>
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>Model is ready.</span>
        </div>
        <Link
          to={libPath(`/models/${modelId}`)}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          View model <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    );
  }

  const label = commitProgress
    ? commitPhaseLabel(commitProgress.phase)
    : 'Saving to library storage';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none shrink-0" />
          {label}…
        </span>
        {commitProgress && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {commitProgress.percent}%
          </span>
        )}
      </div>
      <div
        className="h-2 w-full rounded-full bg-muted overflow-hidden"
        role="progressbar"
        aria-label="Import progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={commitProgress?.percent}
        aria-valuetext={commitProgress
          ? commitProgressValueText(commitProgress)
          : 'Saving to library storage'}
      >
        {commitProgress ? (
          <div
            className="h-full rounded-full bg-primary transition-all duration-500 motion-reduce:transition-none"
            style={{ width: `${commitProgress.percent}%` }}
          />
        ) : (
          <div className="h-full w-1/3 rounded-full bg-primary animate-[slide_1.5s_ease-in-out_infinite] motion-reduce:animate-none" />
        )}
      </div>
      {commitProgress?.phase === 'storing_files' && (
        <div className="space-y-0.5 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-3 tabular-nums">
            <span>
              {formatFileSize(commitProgress.completedBytes)} of{' '}
              {formatFileSize(commitProgress.totalBytes)}
            </span>
            <span>
              {commitProgress.completedFiles} of {commitProgress.totalFiles} files
            </span>
          </div>
          {commitProgress.currentFilename && (
            <p className="truncate font-mono text-[11px]" title={commitProgress.currentFilename}>
              {commitProgress.currentFilename}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
