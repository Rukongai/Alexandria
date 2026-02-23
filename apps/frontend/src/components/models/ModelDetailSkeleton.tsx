import { Skeleton } from '../ui/skeleton';

export function ModelDetailSkeleton() {
  return (
    <div className="flex flex-col lg:flex-row gap-6">
      {/* Left column */}
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        {/* Gallery skeleton */}
        <Skeleton className="w-full aspect-video rounded-xl" />
        {/* Thumbnail strip */}
        <div className="flex gap-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-16 w-16 rounded-lg flex-shrink-0" />
          ))}
        </div>
        {/* File tree skeleton */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-3 w-12" />
          </div>
          <div className="py-1 px-2 flex flex-col gap-1">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="flex items-center gap-2 py-1 px-2" style={{ paddingLeft: `${(i % 3) * 16 + 8}px` }}>
                <Skeleton className="h-4 w-4 flex-shrink-0" />
                <Skeleton className={`h-3 ${i % 3 === 0 ? 'w-40' : 'w-32'}`} />
                {i % 3 !== 0 && <Skeleton className="h-3 w-10 ml-auto" />}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right column */}
      <div className="lg:w-80 xl:w-96 flex flex-col gap-4 flex-shrink-0">
        {/* Model info skeleton */}
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

        {/* Metadata skeleton */}
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

        {/* Collections skeleton */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-muted/30">
            <Skeleton className="h-4 w-24" />
          </div>
          <div className="px-4 py-3 flex flex-col gap-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-28" />
          </div>
        </div>
      </div>
    </div>
  );
}
