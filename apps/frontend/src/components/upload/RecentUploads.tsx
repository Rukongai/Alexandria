import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Loader2, AlertCircle, Package, CheckCircle2, ArrowRight } from 'lucide-react';
import { getModels } from '../../api/models';
import { formatDate, formatFileSize } from '../../lib/format';
import type { ModelCard } from '@alexandria/shared';

function StatusBadge({ status }: { status: ModelCard['status'] }) {
  if (status === 'processing') {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
        <Loader2 className="h-3 w-3 animate-spin" />
        Processing
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex items-center gap-1 text-xs text-destructive">
        <AlertCircle className="h-3 w-3" />
        Error
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-500">
      <CheckCircle2 className="h-3 w-3" />
      Ready
    </span>
  );
}

export function RecentUploads() {
  const { data, isLoading } = useQuery({
    queryKey: ['recent-uploads'],
    queryFn: () =>
      getModels({ sort: 'createdAt', sortDir: 'desc', pageSize: 8 }),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  const models = data?.data ?? [];

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
        <Package className="h-8 w-8 text-muted-foreground/40" />
        <p>No models yet. Upload your first one above.</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-xl border bg-card overflow-hidden">
      {models.map((model) => {
        const thumbnailSrc = model.thumbnailUrl ? `/api${model.thumbnailUrl}` : null;
        return (
          <li key={model.id}>
            <Link
              to={`/models/${model.id}`}
              className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors"
            >
              {/* Thumbnail or placeholder */}
              <div className="h-10 w-10 shrink-0 rounded-md overflow-hidden bg-muted flex items-center justify-center">
                {thumbnailSrc ? (
                  <img
                    src={thumbnailSrc}
                    alt={model.name}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <Package className="h-4 w-4 text-muted-foreground/40" />
                )}
              </div>

              {/* Name + meta */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{model.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatFileSize(model.totalSizeBytes)} &middot; {formatDate(model.createdAt)}
                </p>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <StatusBadge status={model.status} />
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/50" />
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
