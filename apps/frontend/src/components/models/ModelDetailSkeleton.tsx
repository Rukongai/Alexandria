import { Skeleton } from '../ui/skeleton';

export function ModelDetailSkeleton() {
  return (
    <div className="flex flex-col lg:flex-row gap-6">
      {/* Hero column: gallery + 3D action */}
      <div className="flex-1 min-w-0 flex flex-col gap-3">
        <Skeleton className="w-full aspect-video rounded-xl" />
        <div className="flex gap-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-16 w-16 rounded-lg flex-shrink-0" />
          ))}
        </div>
        <Skeleton className="h-11 w-full rounded-xl" />
      </div>

      {/* Tabbed panel column */}
      <div className="lg:w-[380px] xl:w-[420px] flex flex-col gap-3 flex-shrink-0">
        {/* Tab bar */}
        <Skeleton className="h-10 w-full rounded-lg" />

        {/* Info card */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-4 pt-4 pb-3 border-b border-border/60">
            <Skeleton className="h-6 w-3/4 mb-2" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3 mt-1" />
          </div>
          <div className="px-4 py-3 flex flex-col gap-2.5">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="flex items-center justify-between">
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
            ))}
          </div>
        </div>

        {/* Metadata card */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-3 w-8" />
          </div>
          <div className="divide-y divide-border/60">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="px-4 py-2.5 flex gap-3">
                <Skeleton className="h-3.5 w-24 flex-shrink-0 mt-0.5" />
                <Skeleton className="h-3.5 flex-1" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
