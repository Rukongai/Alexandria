import { Package } from 'lucide-react';

interface EmptyLibraryProps {
  hasFilters: boolean;
}

export function EmptyLibrary({ hasFilters }: EmptyLibraryProps) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
        <Package className="h-8 w-8 text-muted-foreground/60" />
      </div>
      {hasFilters ? (
        <>
          <h3 className="text-base font-semibold text-foreground mb-1">No models match your filters</h3>
          <p className="text-sm text-muted-foreground max-w-xs">
            Try adjusting your search terms or clearing some filters to see more results.
          </p>
        </>
      ) : (
        <>
          <h3 className="text-base font-semibold text-foreground mb-1">Your library is empty</h3>
          <p className="text-sm text-muted-foreground max-w-xs">
            Upload a ZIP file or import a folder to start building your 3D printing model collection.
          </p>
        </>
      )}
    </div>
  );
}
