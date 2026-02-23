import { Skeleton } from '../ui/skeleton';
import { useDisplayPreferences } from '../../hooks/use-display-preferences';

export function ModelCardSkeleton() {
  const { cardAspectRatio } = useDisplayPreferences();

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border bg-card shadow">
      {/* Thumbnail */}
      <Skeleton className="w-full rounded-none" style={{ aspectRatio: cardAspectRatio }} />
      {/* Body */}
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-4 w-3/4" />
        <div className="flex gap-1">
          <Skeleton className="h-5 w-12 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <div className="flex items-center justify-between pt-1 border-t border-border/50">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-10" />
        </div>
      </div>
    </div>
  );
}
