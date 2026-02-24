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
  initialCropScale: number | null;
  onClose: () => void;
  onSaved: () => void;
}

function parseRatio(ratio: string): number {
  const [w, h] = ratio.split('/').map(Number);
  return w / h;
}

type Corner = 'tl' | 'tr' | 'bl' | 'br';

export function CoverCropModal({
  image,
  modelId,
  isCurrentCover,
  initialCropX,
  initialCropY,
  initialCropScale,
  onClose,
  onSaved,
}: CoverCropModalProps) {
  const { cardAspectRatio } = useDisplayPreferences();
  const cardRatio = parseRatio(cardAspectRatio);

  const imgRef = React.useRef<HTMLImageElement>(null);

  // Rendered dimensions of the image in the modal
  const [displaySize, setDisplaySize] = React.useState<{ w: number; h: number } | null>(null);

  // The "default" frame is the largest rectangle at cardRatio that fits within the image.
  // This corresponds to cropScale = 1.0 (object-fit:cover baseline).
  const defaultFrameSize = React.useMemo(() => {
    if (!displaySize) return null;
    const imageRatio = displaySize.w / displaySize.h;
    if (imageRatio > cardRatio) {
      const h = displaySize.h;
      return { w: h * cardRatio, h };
    } else {
      const w = displaySize.w;
      return { w, h: w / cardRatio };
    }
  }, [displaySize, cardRatio]);

  // Current frame width (state — user can resize via corners)
  const [frameW, setFrameW] = React.useState<number>(0);
  // Current frame position (top-left, in px relative to image top-left)
  const [framePos, setFramePos] = React.useState<{ left: number; top: number }>({ left: 0, top: 0 });

  // Derived frame height
  const frameH = frameW / cardRatio;

  // Overflow: how much the image overflows the frame on each axis
  const overflow = React.useMemo(() => {
    if (!displaySize) return { x: 0, y: 0 };
    return {
      x: Math.max(0, displaySize.w - frameW),
      y: Math.max(0, displaySize.h - frameH),
    };
  }, [displaySize, frameW, frameH]);

  // Crop values (0–100) derived from current frame position
  const cropValues = React.useMemo(() => ({
    x: overflow.x > 0 ? (framePos.left / overflow.x) * 100 : 50,
    y: overflow.y > 0 ? (framePos.top  / overflow.y) * 100 : 50,
  }), [framePos, overflow]);

  // Crop scale: ratio of default frame width to current frame width
  const cropScale = defaultFrameSize && frameW > 0
    ? Math.round((defaultFrameSize.w / frameW) * 100) / 100
    : 1.0;

  // Initialise frame from saved values once display size is known
  const initialised = React.useRef(false);
  React.useEffect(() => {
    if (!displaySize || !defaultFrameSize || initialised.current) return;
    initialised.current = true;

    const scale = initialCropScale ?? 1.0;
    const initW = defaultFrameSize.w / scale;
    const initH = initW / cardRatio;
    const overflowX = Math.max(0, displaySize.w - initW);
    const overflowY = Math.max(0, displaySize.h - initH);

    setFrameW(initW);
    setFramePos({
      left: (initialCropX ?? 50) / 100 * overflowX,
      top:  (initialCropY ?? 50) / 100 * overflowY,
    });
  }, [displaySize, defaultFrameSize, initialCropX, initialCropY, initialCropScale, cardRatio]);

  // -----------------------------------------------------------------------
  // Clamp helpers
  // -----------------------------------------------------------------------

  function clampPos(left: number, top: number, w: number, h: number, dispW: number, dispH: number) {
    return {
      left: Math.max(0, Math.min(left, dispW - w)),
      top:  Math.max(0, Math.min(top,  dispH - h)),
    };
  }

  const MIN_FRAME_W = defaultFrameSize ? defaultFrameSize.w * 0.15 : 30; // max 6.7x zoom
  const MAX_FRAME_W = defaultFrameSize?.w ?? 9999;                        // can't un-zoom past cover

  // -----------------------------------------------------------------------
  // Frame MOVE drag
  // -----------------------------------------------------------------------

  function handleFrameMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const startMx = e.clientX, startMy = e.clientY;
    const startLeft = framePos.left, startTop = framePos.top;
    const dispW = displaySize!.w, dispH = displaySize!.h;

    function onMove(ev: MouseEvent) {
      setFramePos(clampPos(
        startLeft + ev.clientX - startMx,
        startTop  + ev.clientY - startMy,
        frameW, frameH, dispW, dispH,
      ));
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function handleFrameTouchStart(e: React.TouchEvent) {
    const touch = e.touches[0];
    const startMx = touch.clientX, startMy = touch.clientY;
    const startLeft = framePos.left, startTop = framePos.top;
    const dispW = displaySize!.w, dispH = displaySize!.h;

    function onMove(ev: TouchEvent) {
      const t = ev.touches[0];
      setFramePos(clampPos(
        startLeft + t.clientX - startMx,
        startTop  + t.clientY - startMy,
        frameW, frameH, dispW, dispH,
      ));
    }
    function onEnd() {
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    }
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
  }

  // -----------------------------------------------------------------------
  // Corner RESIZE drag
  // -----------------------------------------------------------------------

  function handleCornerMouseDown(e: React.MouseEvent, corner: Corner) {
    e.preventDefault();
    e.stopPropagation(); // don't fire the frame-move handler

    const startMx = e.clientX;
    const startW  = frameW;
    const startLeft = framePos.left;
    const startTop  = framePos.top;
    const startH  = startW / cardRatio;
    const dispW = displaySize!.w, dispH = displaySize!.h;

    // Anchor = the corner opposite to the one being dragged (stays fixed)
    const anchorRight  = startLeft + startW;  // fixed when dragging left corners
    const anchorBottom = startTop  + startH;  // fixed when dragging top corners

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startMx;

      // Determine new width based on which corner is dragged
      let newW: number;
      if (corner === 'br' || corner === 'tr') {
        newW = startW + dx;
      } else {
        newW = startW - dx;
      }

      // Clamp width to allowed range
      newW = Math.max(MIN_FRAME_W, Math.min(MAX_FRAME_W, newW));
      const newH = newW / cardRatio;

      // Compute new position based on which anchor stays fixed
      let newLeft: number, newTop: number;
      if (corner === 'br') {
        newLeft = startLeft;
        newTop  = startTop;
      } else if (corner === 'tr') {
        newLeft = startLeft;
        newTop  = anchorBottom - newH;
      } else if (corner === 'bl') {
        newLeft = anchorRight - newW;
        newTop  = startTop;
      } else { // tl
        newLeft = anchorRight - newW;
        newTop  = anchorBottom - newH;
      }

      // Clamp so frame stays within image bounds
      if (newLeft < 0) { newLeft = 0; }
      if (newTop  < 0) { newTop  = 0; }
      if (newLeft + newW > dispW) { newW = dispW - newLeft; }
      if (newTop  + newH > dispH) { /* height follows width, adjust W */ newW = Math.min(newW, (dispH - newTop) * cardRatio); }

      newW = Math.max(MIN_FRAME_W, newW);
      setFrameW(newW);
      setFramePos({ left: newLeft, top: newTop });
    }

    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // -----------------------------------------------------------------------
  // Save
  // -----------------------------------------------------------------------

  const [saving, setSaving] = React.useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await updateModel(modelId, {
        previewImageFileId: image.id,
        previewCropX:    Math.round(cropValues.x * 10) / 10,
        previewCropY:    Math.round(cropValues.y * 10) / 10,
        previewCropScale: Math.round(cropScale * 100) / 100,
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

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  // Live preview: fixed 140px wide, height from card ratio
  const PREVIEW_W = 140;
  const PREVIEW_H = Math.round(PREVIEW_W / cardRatio);

  const cornerHandles: { corner: Corner; style: React.CSSProperties }[] = [
    { corner: 'tl', style: { top: -5, left: -5, cursor: 'nw-resize' } },
    { corner: 'tr', style: { top: -5, right: -5, cursor: 'ne-resize' } },
    { corner: 'bl', style: { bottom: -5, left: -5, cursor: 'sw-resize' } },
    { corner: 'br', style: { bottom: -5, right: -5, cursor: 'se-resize' } },
  ];

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
        <div className="flex items-center justify-between px-5 pt-5 pb-3 flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {isCurrentCover ? 'Edit Cover Framing' : 'Set Cover Image'}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Drag the frame to reposition · drag corners to zoom
            </p>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0 ml-3"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Side-by-side: image crop area + card preview */}
        <div className="flex gap-3 px-5 pb-5">

          {/* Crop area — flex-1 so it fills remaining space */}
          <div className="flex-1 min-w-0">
            <div
              className="relative overflow-hidden rounded-lg bg-muted select-none"
              style={{ lineHeight: 0 }}
            >
              {/* Full image at natural aspect ratio */}
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

              {/* Crop frame overlay */}
              {frameW > 0 && displaySize && (
                <div
                  className="absolute"
                  style={{
                    left:   framePos.left,
                    top:    framePos.top,
                    width:  frameW,
                    height: frameH,
                    cursor: 'move',
                    boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
                    border: '2px solid rgba(255,255,255,0.9)',
                    borderRadius: 2,
                  }}
                  onMouseDown={handleFrameMouseDown}
                  onTouchStart={handleFrameTouchStart}
                >
                  {/* Rule-of-thirds grid */}
                  <div className="absolute inset-0 pointer-events-none opacity-30">
                    <div className="absolute top-1/3 left-0 right-0 h-px bg-white" />
                    <div className="absolute top-2/3 left-0 right-0 h-px bg-white" />
                    <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white" />
                    <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white" />
                  </div>

                  {/* Corner resize handles */}
                  {cornerHandles.map(({ corner, style }) => (
                    <div
                      key={corner}
                      className="absolute w-3 h-3 bg-white rounded-sm shadow"
                      style={style}
                      onMouseDown={(e) => handleCornerMouseDown(e, corner)}
                    />
                  ))}
                </div>
              )}

              {/* Loading state */}
              {!displaySize && (
                <div className="absolute inset-0 flex items-center justify-center bg-muted">
                  <span className="text-sm text-muted-foreground">Loading…</span>
                </div>
              )}
            </div>
          </div>

          {/* Live card preview — fixed width */}
          <div className="flex-shrink-0 flex flex-col gap-1.5 pt-0.5">
            <span className="text-xs text-muted-foreground">Preview</span>
            <div
              className="rounded-lg overflow-hidden border border-border bg-muted shadow-sm"
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
                    ...(cropScale > 1.0
                      ? {
                          transform: `scale(${cropScale})`,
                          transformOrigin: `${cropValues.x}% ${cropValues.y}%`,
                        }
                      : {}),
                  }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <span className="text-xs text-muted-foreground">…</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4 flex-shrink-0">
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
  );
}
