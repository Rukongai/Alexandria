import * as React from 'react';
import { X } from 'lucide-react';
import type { ImageFile } from '@alexandria/shared';
import { updateModel } from '../../api/models';
import { toast } from '../../hooks/use-toast';
import { useDisplayPreferences } from '../../hooks/use-display-preferences';

interface CoverCropModalProps {
  image: ImageFile;
  modelId: string;
  isCurrentCover: boolean;
  initialCropX: number | null;
  initialCropY: number | null;
  onClose: () => void;
  onSaved: () => void;
}

/** Parse '4/3', '3/4', '1/1', '2/3' → numeric ratio (width / height). */
function parseRatio(ratio: string): number {
  const [w, h] = ratio.split('/').map(Number);
  return w / h;
}

export function CoverCropModal({
  image,
  modelId,
  isCurrentCover,
  initialCropX,
  initialCropY,
  onClose,
  onSaved,
}: CoverCropModalProps) {
  const { cardAspectRatio } = useDisplayPreferences();
  const cardRatio = parseRatio(cardAspectRatio);

  const imgRef = React.useRef<HTMLImageElement>(null);

  // Dimensions of the image as rendered in the modal (px)
  const [displaySize, setDisplaySize] = React.useState<{ w: number; h: number } | null>(null);

  // Frame size — computed from display size and card ratio (matches object-fit:cover region)
  const frameSize = React.useMemo(() => {
    if (!displaySize) return null;
    const imageRatio = displaySize.w / displaySize.h;
    if (imageRatio > cardRatio) {
      // Image wider than card frame → frame fills height
      const h = displaySize.h;
      const w = h * cardRatio;
      return { w, h };
    } else {
      // Image taller (or equal) to card frame → frame fills width
      const w = displaySize.w;
      const h = w / cardRatio;
      return { w, h };
    }
  }, [displaySize, cardRatio]);

  // Overflow: how much the image extends beyond the frame on each axis
  const overflow = React.useMemo(() => {
    if (!displaySize || !frameSize) return { x: 0, y: 0 };
    return {
      x: displaySize.w - frameSize.w,
      y: displaySize.h - frameSize.h,
    };
  }, [displaySize, frameSize]);

  // Frame position (top-left corner, in px relative to image top-left)
  const [framePos, setFramePos] = React.useState<{ left: number; top: number }>({ left: 0, top: 0 });

  // Initialise frame position from saved crop values once we have display dimensions
  const initialised = React.useRef(false);
  React.useEffect(() => {
    if (displaySize && frameSize && !initialised.current) {
      initialised.current = true;
      const cx = initialCropX ?? 50;
      const cy = initialCropY ?? 50;
      setFramePos({
        left: (cx / 100) * overflow.x,
        top: (cy / 100) * overflow.y,
      });
    }
  }, [displaySize, frameSize, initialCropX, initialCropY, overflow]);

  // Current crop percentages derived from frame position
  const cropValues = React.useMemo(() => ({
    x: overflow.x > 0 ? (framePos.left / overflow.x) * 100 : 50,
    y: overflow.y > 0 ? (framePos.top  / overflow.y) * 100 : 50,
  }), [framePos, overflow]);

  function clamp(left: number, top: number) {
    return {
      left: Math.max(0, Math.min(left, overflow.x)),
      top:  Math.max(0, Math.min(top,  overflow.y)),
    };
  }

  function handleMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const startMx = e.clientX;
    const startMy = e.clientY;
    const startLeft = framePos.left;
    const startTop  = framePos.top;

    function onMove(ev: MouseEvent) {
      setFramePos(clamp(startLeft + ev.clientX - startMx, startTop + ev.clientY - startMy));
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function handleTouchStart(e: React.TouchEvent) {
    const touch = e.touches[0];
    const startMx = touch.clientX;
    const startMy = touch.clientY;
    const startLeft = framePos.left;
    const startTop  = framePos.top;

    function onMove(ev: TouchEvent) {
      const t = ev.touches[0];
      setFramePos(clamp(startLeft + t.clientX - startMx, startTop + t.clientY - startMy));
    }
    function onEnd() {
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    }
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
  }

  const [saving, setSaving] = React.useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await updateModel(modelId, {
        previewImageFileId: image.id,
        previewCropX: Math.round(cropValues.x * 10) / 10,
        previewCropY: Math.round(cropValues.y * 10) / 10,
      });
      onSaved();
      onClose();
    } catch {
      toast({ title: 'Failed to save cover', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  // Close on Escape
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Live preview dimensions
  const PREVIEW_W = 160;
  const PREVIEW_H = Math.round(PREVIEW_W / cardRatio);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Crop cover image"
    >
      <div
        className="relative bg-card border border-border rounded-2xl shadow-2xl flex flex-col w-full max-w-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {isCurrentCover ? 'Edit Cover Framing' : 'Set Cover Image'}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Drag the frame to choose what shows in library cards
            </p>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Image + crop overlay */}
        <div className="px-5">
          <div
            className="relative overflow-hidden rounded-lg bg-muted select-none"
            style={{ lineHeight: 0 }}
          >
            {/* The full image at natural aspect ratio */}
            <img
              ref={imgRef}
              src={`/api${image.originalUrl}`}
              alt={image.filename}
              draggable={false}
              className="w-full h-auto block"
              onLoad={() => {
                const img = imgRef.current!;
                setDisplaySize({ w: img.offsetWidth, h: img.offsetHeight });
              }}
            />

            {/* Crop frame overlay — shown once we have display dimensions */}
            {frameSize && (
              <div
                className="absolute"
                style={{
                  left: framePos.left,
                  top:  framePos.top,
                  width:  frameSize.w,
                  height: frameSize.h,
                  cursor: 'move',
                  // box-shadow dims everything outside the frame; parent overflow:hidden clips it
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
                  border: '2px solid rgba(255,255,255,0.9)',
                  borderRadius: 2,
                  outline: '1px solid rgba(255,255,255,0.25)',
                  outlineOffset: 3,
                }}
                onMouseDown={handleMouseDown}
                onTouchStart={handleTouchStart}
              >
                {/* Rule-of-thirds grid lines */}
                <div className="absolute inset-0 pointer-events-none" style={{ opacity: 0.35 }}>
                  <div className="absolute top-1/3 left-0 right-0 h-px bg-white" />
                  <div className="absolute top-2/3 left-0 right-0 h-px bg-white" />
                  <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white" />
                  <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white" />
                </div>

                {/* Corner handles */}
                {['top-left','top-right','bottom-left','bottom-right'].map((pos) => (
                  <div
                    key={pos}
                    className="absolute"
                    style={{
                      width: 12, height: 12,
                      background: 'white',
                      borderRadius: 2,
                      ...(pos.includes('top')    ? { top: -5 }    : { bottom: -5 }),
                      ...(pos.includes('left')   ? { left: -5 }   : { right: -5 }),
                    }}
                  />
                ))}
              </div>
            )}

            {/* Loading placeholder */}
            {!displaySize && (
              <div className="absolute inset-0 flex items-center justify-center bg-muted">
                <span className="text-sm text-muted-foreground">Loading…</span>
              </div>
            )}
          </div>
        </div>

        {/* Live card preview + actions */}
        <div className="px-5 pt-4 pb-5 flex flex-col gap-4">
          {/* Preview row */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground flex-shrink-0">Card preview</span>
            <div
              className="rounded-lg overflow-hidden border border-border bg-muted shadow-sm flex-shrink-0"
              style={{ width: PREVIEW_W, height: PREVIEW_H }}
            >
              {displaySize ? (
                <img
                  src={`/api${image.originalUrl}`}
                  alt="Card preview"
                  draggable={false}
                  className="w-full h-full object-cover"
                  style={{
                    objectPosition: `${cropValues.x}% ${cropValues.y}%`,
                  }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <span className="text-xs text-muted-foreground">…</span>
                </div>
              )}
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">
              {Math.round(cropValues.x)}% · {Math.round(cropValues.y)}%
            </span>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
            <button
              onClick={onClose}
              className="h-9 px-4 rounded-lg border border-input bg-background text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !displaySize}
              className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : 'Set Cover'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
