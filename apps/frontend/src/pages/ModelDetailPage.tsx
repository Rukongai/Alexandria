import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, AlertTriangle } from 'lucide-react';
import { getModel, getModelFiles } from '../api/models';
import { ImageGallery } from '../components/models/ImageGallery';
import { FileTree } from '../components/models/FileTree';
import { MetadataPanel } from '../components/models/MetadataPanel';
import { ModelInfo } from '../components/models/ModelInfo';
import { CollectionsList } from '../components/models/CollectionsList';
import { ModelDetailSkeleton } from '../components/models/ModelDetailSkeleton';

export function ModelDetailPage() {
  const { id } = useParams<{ id: string }>();

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

  return (
    <div className="flex flex-col gap-5 max-w-6xl mx-auto">
      {/* Back nav */}
      <div>
        <Link
          to="/"
          className="inline-flex items-center gap-0.5 h-8 px-2 -ml-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Back to Library
        </Link>
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
            to="/"
            className="inline-flex items-center justify-center h-9 px-4 rounded-md border border-input bg-background text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            Go to Library
          </Link>
        </div>
      )}

      {model && !isLoading && (
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Left column: gallery + file tree */}
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            <ImageGallery images={model.images} />
            <FileTree tree={fileTree} />
          </div>

          {/* Right column: info, metadata, collections */}
          <div className="lg:w-80 xl:w-96 flex flex-col gap-4 flex-shrink-0">
            <ModelInfo model={model} />
            <MetadataPanel metadata={model.metadata} modelId={model.id} />
            <CollectionsList collections={model.collections} />
          </div>
        </div>
      )}
    </div>
  );
}
