import * as React from 'react';
import { X, Move } from 'lucide-react';
import type { ImageFile } from '@alexandria/shared';
import { updateModel } from '../../api/models';
import { toast } from '../../hooks/use-toast';
import { useDisplayPreferences } from '../../hooks/use-display-preferences';
import { cn } from '../../lib/utils';

interface CoverCropModalProps {
  image: ImageFile;
  modelId: string;
  isCurrentCover: boolean;
  initialCropX: number | null;
  initialCropY: number | null;
  onClose: () => void;
  onSaved: () => void;
}

const FRAME_W = 560;

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
  const ratio = parseRatio(cardAspectRatio);
  const FRAME_H = Math.round(FRAME_W / ratio);

  // Track natural image dimensions
  const [naturalSize, setNaturalSize] = React.useState<{ w: number; h: number } | null>(null);

  // Derived display dimensions (image scaled to cover the frame)
  const displaySize = React.useMemo(() => {
    if (!naturalSize) return null;
    const scaleX = FRAME_W / naturalSize.w;
    const scaleY = FRAME_H / naturalSize.h;
    const scale = Math.max(scaleX, scaleY);
    return { w: naturalSize.w * scale, h: naturalSize.h * scale };
  }, [naturalSize, FRAME_W, FRAME_H]);

  // Overflow (how many px the image extends beyond the frame on each axis)
  const overflow = React.useMemo(() => {
    if (!displaySize) return { x: 0, y: 0 };
    return {
      x: displaySize.w - FRAME_W,
      y: displaySize.h - FRAME_H,
    };
  }, [displaySize, FRAME_W, FRAME_H]);

  // Current pixel offset of the image top-left relative to the frame top-left.
  // Clamped to [-overflowX, 0] and [-overflowY, 0].
  const [offset, setOffset] = React.useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Initialise offset from stored crop values once we know the display size
  const initialised = React.useRef(false);
  React.useEffect(() => {
    if (displaySize && !initialised.current) {
      initialised.current = true;
      const cropX = initialCropX ?? 50;
      const cropY = initialCropY ?? 50;
      const ox = overflow.x > 0 ? -(cropX / 100) * overflow.x : 0;
      const oy = overflow.y > 0 ? -(cropY / 100) * overflow.y : 0;
      setOffset({ x: ox, y: oy });
    }
  }, [displaySize, initialCropX, initialCropY, overflow]);

  // Current crop percentages (0–100)
  const cropValues = React.useMemo(() => {
    const cropX = overflow.x > 0 ? (-offset.x / overflow.x) * 100 : 50;
    const cropY = overflow.y > 0 ? (-offset.y / overflow.y) * 100 : 50;
    return { x: Math.round(cropX * 10) / 10, y: Math.round(cropY * 10) / 10 };
  }, [offset, overflow]);

  // Drag state
  const dragging = React.useRef(false);
  const dragStart = React.useRef<{ mx: number; my: number; ox: number; oy: number }>({
    mx: 0,
    my: 0,
    ox: 0,
    oy: 0,
  });

  function clampOffset(ox: number, oy: number) {
    return {
      x: Math.min(0, Math.max(-overflow.x, ox)),
      y: Math.min(0, Math.max(-overflow.y, oy)),
    };
  }

  function handleMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    dragging.current = true;
    dragStart.current = { mx: e.clientX, my: e.clientY, ox: offset.x, oy: offset.y };

    function onMove(ev: MouseEvent) {
      if (!dragging.current) return;
      const dx = ev.clientX - dragStart.current.mx;
      const dy = ev.clientY - dragStart.current.my;
      setOffset(clampOffset(dragStart.current.ox + dx, dragStart.current.oy + dy));
    }

    function onUp() {
      dragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // Touch support
  function handleTouchStart(e: React.TouchEvent) {
    const touch = e.touches[0];
    dragging.current = true;
    dragStart.current = { mx: touch.clientX, my: touch.clientY, ox: offset.x, oy: offset.y };

    function onMove(ev: TouchEvent) {
      if (!dragging.current) return;
      const t = ev.touches[0];
      const dx = t.clientX - dragStart.current.mx;
      const dy = t.clientY - dragStart.current.my;
      setOffset(clampOffset(dragStart.current.ox + dx, dragStart.current.oy + dy));
    }

    function onEnd() {
      dragging.current = false;
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
        previewCropX: cropValues.x,
        previewCropY: cropValues.y,
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

  // Preview card dimensions (scaled down for the live preview)
  const PREVIEW_W = 180;
  const PREVIEW_H = Math.round(PREVIEW_W / ratio);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Crop cover image"
    >
      <div
        className="relative bg-card border border-border rounded-2xl shadow-2xl flex flex-col gap-5 p-6 max-w-3xl w-full max-h-[95vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {isCurrentCover ? 'Edit Cover Framing' : 'Set Cover Image'}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Drag the image to choose what shows in library cards
            </p>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Crop area + live preview side by side */}
        <div className="flex flex-col sm:flex-row gap-6 items-start">
          {/* Crop area */}
          <div className="flex flex-col gap-2 items-center flex-1">
            <p className="text-xs text-muted-foreground self-start flex items-center gap-1">
              <Move className="h-3 w-3" />
              Drag to reframe
            </p>
            <div
              className="relative overflow-hidden rounded-lg border-2 border-primary select-none"
              style={{ width: FRAME_W, height: FRAME_H, maxWidth: '100%', cursor: 'grab' }}
              onMouseDown={handleMouseDown}
              onTouchStart={handleTouchStart}
            >
              {/* Drag instruction overlay when no image loaded yet */}
              {!naturalSize && (
                <div className="absolute inset-0 flex items-center justify-center bg-muted">
                  <span className="text-sm text-muted-foreground">Loading…</span>
                </div>
              )}
              <img
                src={`/api${image.originalUrl}`}
                alt={image.filename}
                draggable={false}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
                }}
                style={{
                  position: 'absolute',
                  width: displaySize?.w ?? 'auto',
                  height: displaySize?.h ?? 'auto',
                  left: offset.x,
                  top: offset.y,
                  userSelect: 'none',
                  pointerEvents: 'none',
                }}
              />
              {/* Frame border overlay */}
              <div className="absolute inset-0 pointer-events-none ring-2 ring-primary rounded-lg" />
            </div>
          </div>

          {/* Live card preview */}
          <div className="flex flex-col gap-2 items-center flex-shrink-0">
            <p className="text-xs text-muted-foreground self-start">Card preview</p>
            <div
              className={cn(
                'rounded-lg overflow-hidden border border-border bg-muted shadow',
              )}
              style={{ width: PREVIEW_W, height: PREVIEW_H }}
            >
              {naturalSize ? (
                <img
                  src={`/api${image.originalUrl}`}
                  alt="Preview"
                  draggable={false}
                  className="w-full h-full object-cover"
                  style={{
                    objectPosition: `${cropValues.x}% ${cropValues.y}%`,
                  }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <span className="text-xs text-muted-foreground">Loading…</span>
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {Math.round(cropValues.x)}% · {Math.round(cropValues.y)}%
            </p>
          </div>
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
            disabled={saving || !naturalSize}
            className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Set Cover'}
          </button>
        </div>
      </div>
    </div>
  );
}
