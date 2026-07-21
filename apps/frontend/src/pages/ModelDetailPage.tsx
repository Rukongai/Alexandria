import * as React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, AlertTriangle, Download } from 'lucide-react';
import { getModel, getModelFiles } from '../api/models';
import { ModelHero } from '../components/models/ModelHero';
import { ModelDetailPanel } from '../components/models/ModelDetailPanel';
import { ModelBreadcrumb } from '../components/models/ModelBreadcrumb';
import { ModelViewer3DModal } from '../components/models/ModelViewer3DModal';
import { ModelDetailSkeleton } from '../components/models/ModelDetailSkeleton';
import { collectStlFiles, type StlFileRef } from '../lib/model-files';
import { useLibraryPath } from '../hooks/use-libraries';
import { buttonVariants } from '../components/ui/button';
import { cn } from '../lib/utils';

export function ModelDetailPage() {
  const { id } = useParams<{ id: string }>();
  const libPath = useLibraryPath();

  const {
    data: model,
    isLoading: modelLoading,
    isError: modelError,
    error: modelErr,
  } = useQuery({
    queryKey: ['model', id],
    queryFn: () => getModel(id!),
    enabled: Boolean(id),
  });

  const { data: fileTree = [], isLoading: filesLoading } = useQuery({
    queryKey: ['model-files', id],
    queryFn: () => getModelFiles(id!),
    enabled: Boolean(id),
  });

  const isLoading = modelLoading || filesLoading;

  // STL files discovered from the file tree (drives the 3D viewer).
  const stlFiles = React.useMemo(
    () => (id ? collectStlFiles(fileTree, id) : []),
    [fileTree, id],
  );

  const [viewerOpen, setViewerOpen] = React.useState(false);
  const [activeStl, setActiveStl] = React.useState<StlFileRef | null>(null);

  function openViewer(stl: StlFileRef) {
    setActiveStl(stl);
    setViewerOpen(true);
  }

  return (
    <div className="flex flex-col gap-4 max-w-[1400px] mx-auto p-3 sm:p-6">
      {/* Header: navigation, model action, and breadcrumb */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Link
            to={libPath('/')}
            className="inline-flex items-center gap-0.5 h-8 px-2 -ml-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="Back to Library"
            title="Back to Library"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Back to Library</span>
          </Link>
          {model && !isLoading && (
            <a
              href={`/api/models/${model.id}/download`}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-2')}
              download={`${model.slug}.zip`}
              aria-label="Download ZIP"
              title="Download ZIP"
            >
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">Download ZIP</span>
            </a>
          )}
        </div>
        {model && !isLoading && (
          <ModelBreadcrumb
            collection={model.collections[0] ?? null}
            modelName={model.name}
          />
        )}
      </div>

      {isLoading && <ModelDetailSkeleton />}

      {modelError && !isLoading && (
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive/70" />
          <div>
            <p className="text-lg font-semibold text-foreground">Model not found</p>
            <p className="text-sm text-muted-foreground mt-1">
              {(modelErr as Error)?.message ?? 'This model could not be loaded.'}
            </p>
          </div>
          <Link
            to={libPath('/')}
            className="inline-flex items-center justify-center h-9 px-4 rounded-md border border-input bg-background text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            Go to Library
          </Link>
        </div>
      )}

      {model && !isLoading && (
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Hero column */}
          <div className="flex-1 min-w-0">
            <ModelHero model={model} stlFiles={stlFiles} onOpenViewer={openViewer} />
          </div>

          {/* Tabbed panel column */}
          <div className="lg:w-[380px] xl:w-[420px] flex-shrink-0">
            <ModelDetailPanel
              model={model}
              fileTree={fileTree}
              onOpenStl={openViewer}
            />
          </div>
        </div>
      )}

      <ModelViewer3DModal
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        stlFiles={stlFiles}
        initialStl={activeStl}
      />
    </div>
  );
}
