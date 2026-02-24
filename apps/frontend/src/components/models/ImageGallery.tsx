import * as React from 'react';
import { ChevronLeft, ChevronRight, X, Package, Star, Crop } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { ImageFile } from '@alexandria/shared';
import { cn } from '../../lib/utils';
import { CoverCropModal } from './CoverCropModal';

interface ImageGalleryProps {
  images: ImageFile[];
  previewImageFileId: string | null;
  previewCropX: number | null;
  previewCropY: number | null;
  modelId: string;
}

export function ImageGallery({
  images,
  previewImageFileId,
  previewCropX,
  previewCropY,
  modelId,
}: ImageGalleryProps) {
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [lightboxOpen, setLightboxOpen] = React.useState(false);
  const [cropModalImage, setCropModalImage] = React.useState<ImageFile | null>(null);
  const queryClient = useQueryClient();

  function handleOpenCropModal(image: ImageFile) {
    setCropModalImage(image);
  }

  function handleCropSaved() {
    queryClient.invalidateQueries({ queryKey: ['model', modelId] });
    queryClient.invalidateQueries({ queryKey: ['models'] });
  }

  React.useEffect(() => {
    if (!lightboxOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setLightboxOpen(false);
      } else if (e.key === 'ArrowLeft') {
        setSelectedIndex((i) => (i > 0 ? i - 1 : images.length - 1));
      } else if (e.key === 'ArrowRight') {
        setSelectedIndex((i) => (i < images.length - 1 ? i + 1 : 0));
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightboxOpen, images.length]);

  if (images.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center aspect-video bg-muted rounded-xl border border-border gap-3 text-muted-foreground">
        <Package className="h-12 w-12 opacity-40" />
        <span className="text-sm">No images</span>
      </div>
    );
  }

  const selected = images[selectedIndex];
  const isSelectedCover = selected.id === previewImageFileId;

  return (
    <>
      {/* Main image */}
      <div className="relative rounded-xl overflow-hidden bg-muted border border-border group">
        <img
          src={`/api${selected.originalUrl}`}
          alt={selected.filename}
          className="w-full aspect-video object-contain cursor-zoom-in"
          onClick={() => setLightboxOpen(true)}
        />
        {isSelectedCover && (
          <div className="absolute top-2 left-2 flex items-center gap-1 bg-amber-500/90 text-white text-xs font-medium rounded-full px-2 py-0.5 pointer-events-none">
            <Star className="h-3 w-3 fill-white" />
            Cover
          </div>
        )}
        {/* Set Preview / Edit Framing button */}
        <button
          onClick={(e) => { e.stopPropagation(); handleOpenCropModal(selected); }}
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 bg-black/60 hover:bg-black/80 text-white text-xs font-medium rounded-full px-2.5 py-1"
        >
          {isSelectedCover ? (
            <>
              <Crop className="h-3 w-3" />
              Edit Framing
            </>
          ) : (
            <>
              <Star className="h-3 w-3" />
              Set Preview
            </>
          )}
        </button>
        {images.length > 1 && (
          <>
            <button
              onClick={() => setSelectedIndex((i) => (i > 0 ? i - 1 : images.length - 1))}
              className="absolute left-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70 transition-colors"
              aria-label="Previous image"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              onClick={() => setSelectedIndex((i) => (i < images.length - 1 ? i + 1 : 0))}
              className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70 transition-colors"
              aria-label="Next image"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
            <div className="absolute bottom-2 right-3 text-xs text-white bg-black/50 rounded-full px-2 py-0.5">
              {selectedIndex + 1} / {images.length}
            </div>
          </>
        )}
      </div>

      {/* Thumbnail strip */}
      {images.length > 1 && (
        <div className="flex gap-2 mt-2 overflow-x-auto pb-1">
          {images.map((image, index) => {
            const isCover = image.id === previewImageFileId;
            return (
              <div key={image.id} className="relative flex-shrink-0 group">
                <button
                  onClick={() => setSelectedIndex(index)}
                  className={cn(
                    'w-16 h-16 rounded-lg overflow-hidden border-2 transition-colors',
                    index === selectedIndex
                      ? 'border-primary'
                      : 'border-transparent hover:border-border',
                    isCover && 'ring-2 ring-amber-400 ring-offset-1'
                  )}
                >
                  <img
                    src={`/api${image.thumbnailUrl}`}
                    alt={image.filename}
                    className="w-full h-full object-cover"
                  />
                </button>
                {isCover && (
                  <div className="absolute top-0.5 right-0.5 bg-amber-500/90 rounded-full p-0.5 pointer-events-none">
                    <Star className="h-2.5 w-2.5 fill-white text-white" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Lightbox */}
      {lightboxOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setLightboxOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Image lightbox"
        >
          <div
            className="relative max-w-5xl w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={`/api${selected.originalUrl}`}
              alt={selected.filename}
              className="max-h-[85vh] w-full object-contain rounded-lg"
            />

            {/* Close */}
            <button
              onClick={() => setLightboxOpen(false)}
              className="absolute top-2 right-2 h-8 w-8 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors"
              aria-label="Close lightbox"
            >
              <X className="h-4 w-4" />
            </button>

            {/* Counter */}
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-sm text-white bg-black/60 rounded-full px-3 py-1">
              {selectedIndex + 1} / {images.length}
            </div>

            {/* Prev / Next */}
            {images.length > 1 && (
              <>
                <button
                  onClick={() => setSelectedIndex((i) => (i > 0 ? i - 1 : images.length - 1))}
                  className="absolute left-2 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors"
                  aria-label="Previous image"
                >
                  <ChevronLeft className="h-6 w-6" />
                </button>
                <button
                  onClick={() => setSelectedIndex((i) => (i < images.length - 1 ? i + 1 : 0))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors"
                  aria-label="Next image"
                >
                  <ChevronRight className="h-6 w-6" />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Crop Modal */}
      {cropModalImage && (
        <CoverCropModal
          image={cropModalImage}
          modelId={modelId}
          isCurrentCover={cropModalImage.id === previewImageFileId}
          initialCropX={cropModalImage.id === previewImageFileId ? previewCropX : null}
          initialCropY={cropModalImage.id === previewImageFileId ? previewCropY : null}
          onClose={() => setCropModalImage(null)}
          onSaved={handleCropSaved}
        />
      )}
    </>
  );
}
