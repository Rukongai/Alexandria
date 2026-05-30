import type { ModelDetail } from '@alexandria/shared';
import { ImageGallery } from './ImageGallery';
import { Model3DIcon } from '../icons';
import { getPrimaryStl, type StlFileRef } from '../../lib/model-files';

interface ModelHeroProps {
  model: ModelDetail;
  stlFiles: StlFileRef[];
  onOpenViewer: (stl: StlFileRef) => void;
}

/**
 * Hero column of the model detail page: the existing image gallery plus a
 * prominent "View in 3D" action. The action is hidden entirely when the model
 * has no STL files.
 */
export function ModelHero({ model, stlFiles, onOpenViewer }: ModelHeroProps) {
  const primaryStl = getPrimaryStl(stlFiles);

  return (
    <div className="flex flex-col gap-3">
      <ImageGallery
        images={model.images}
        previewImageFileId={model.previewImageFileId}
        previewCropX={model.previewCropX}
        previewCropY={model.previewCropY}
        previewCropScale={model.previewCropScale}
        modelId={model.id}
      />

      {primaryStl && (
        <button
          type="button"
          onClick={() => onOpenViewer(primaryStl)}
          className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-xl text-sm font-semibold shadow-sm transition-colors"
          style={{
            background: 'var(--ax-amber)',
            color: 'var(--ax-amber-fg, white)',
          }}
        >
          <Model3DIcon className="h-4 w-4" />
          View in 3D
          {stlFiles.length > 1 && (
            <span className="text-xs font-normal opacity-80">
              ({stlFiles.length} models)
            </span>
          )}
        </button>
      )}
    </div>
  );
}
