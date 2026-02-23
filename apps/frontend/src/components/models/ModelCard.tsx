import { useNavigate } from 'react-router-dom';
import { Package, AlertCircle, Loader2 } from 'lucide-react';
import type { ModelCard as ModelCardType } from '@alexandria/shared';
import { Badge } from '../ui/badge';
import { formatFileSize } from '../../lib/format';

interface ModelCardProps {
  model: ModelCardType;
}

function StatusIndicator({ status }: { status: ModelCardType['status'] }) {
  if (status === 'processing') {
    return (
      <span className="flex items-center gap-1 text-amber-500">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="text-xs">Processing</span>
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex items-center gap-1 text-destructive">
        <AlertCircle className="h-3 w-3" />
        <span className="text-xs">Error</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-emerald-500">
      <span className="h-2 w-2 rounded-full bg-emerald-500" />
      <span className="text-xs text-muted-foreground">Ready</span>
    </span>
  );
}

export function ModelCard({ model }: ModelCardProps) {
  const navigate = useNavigate();

  const tags = model.metadata
    .filter((m) => m.fieldSlug === 'tags')
    .flatMap((m) => (Array.isArray(m.value) ? m.value : [m.value]))
    .slice(0, 3);

  const thumbnailSrc = model.thumbnailUrl ? `/api${model.thumbnailUrl}` : null;

  return (
    <article
      className="group relative flex flex-col overflow-hidden rounded-xl border bg-card shadow transition-all hover:shadow-md hover:-translate-y-0.5 cursor-pointer"
      onClick={() => navigate(`/models/${model.id}`)}
      aria-label={`View model: ${model.name}`}
    >
      {/* Thumbnail area */}
      <div className="relative aspect-[4/3] overflow-hidden bg-muted">
        {thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt={model.name}
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Package className="h-12 w-12 text-muted-foreground/40" />
          </div>
        )}
      </div>

      {/* Card body */}
      <div className="flex flex-col gap-2 p-3">
        <h3 className="truncate text-sm font-semibold text-foreground leading-tight" title={model.name}>
          {model.name}
        </h3>

        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <Badge key={tag} variant="accent" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between pt-1 border-t border-border/50">
          <span className="text-xs text-muted-foreground">
            {model.fileCount} {model.fileCount === 1 ? 'file' : 'files'} &middot; {formatFileSize(model.totalSizeBytes)}
          </span>
          <StatusIndicator status={model.status} />
        </div>
      </div>
    </article>
  );
}
