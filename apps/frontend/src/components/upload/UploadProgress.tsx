import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Loader2, CheckCircle2, AlertCircle, ArrowRight } from 'lucide-react';
import { getModelStatus } from '../../api/models';
import type { JobStatus } from '@alexandria/shared';

interface UploadProgressProps {
  modelId: string;
}

function statusLabel(status: JobStatus['status'], progress: number | null): string {
  if (status === 'error') return 'Processing failed';
  if (status === 'ready') return 'Done!';
  if (progress === null || progress === 0) return 'Processing...';
  if (progress < 40) return 'Extracting files...';
  if (progress < 70) return 'Classifying files...';
  if (progress < 90) return 'Generating thumbnails...';
  return 'Finishing up...';
}

export function UploadProgress({ modelId }: UploadProgressProps) {
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

  // progress from job (0-100), null means indeterminate
  const progress = status?.progress ?? null;
  const pct = typeof progress === 'number' ? progress : 0;
  const isIndeterminate = progress === null && status?.status === 'processing';

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
        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
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
          to={`/models/${modelId}`}
          className="text-sm text-primary hover:underline inline-flex items-center gap-1"
        >
          View model anyway <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    );
  }

  if (status.status === 'ready') {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-500">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>Model is ready.</span>
        </div>
        <Link
          to={`/models/${modelId}`}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          View model <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          {statusLabel(status.status, progress)}
        </span>
        {!isIndeterminate && (
          <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
        )}
      </div>
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        {isIndeterminate ? (
          <div className="h-full w-1/3 rounded-full bg-primary animate-[slide_1.5s_ease-in-out_infinite]" />
        ) : (
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}
