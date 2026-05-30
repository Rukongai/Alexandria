import * as React from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { Model3DIcon, ResetViewIcon } from '../icons';
import type { StlFileRef } from '../../lib/model-files';

// three.js + the scene live in a separate async chunk, loaded only when the
// viewer first opens. Nothing else in the app imports three statically.
const ModelViewer3DScene = React.lazy(() => import('./ModelViewer3DScene'));

interface ModelViewer3DModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All STL files for the model (drives the switcher when more than one). */
  stlFiles: StlFileRef[];
  /** The STL to show when the modal opens. */
  initialStl: StlFileRef | null;
}

/** Centered spinner shown while the three.js chunk / STL is loading. */
function ViewerLoading() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
      <Loader2 className="h-7 w-7 animate-spin" />
      <span className="text-sm">Loading 3D viewer…</span>
    </div>
  );
}

/** Error boundary around the scene; bumping `resetKey` remounts to retry. */
class SceneErrorBoundary extends React.Component<
  { resetKey: unknown; onRetry: () => void; children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: { resetKey: unknown }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6 text-muted-foreground">
          <AlertTriangle className="h-8 w-8 text-destructive/70" />
          <p className="text-sm font-medium text-foreground">
            Couldn&apos;t load this model
          </p>
          <p className="text-xs">
            The file may be missing, too large, or in an unsupported format.
          </p>
          <button
            type="button"
            onClick={this.props.onRetry}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent transition-colors"
          >
            <ResetViewIcon className="h-3.5 w-3.5" />
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function ModelViewer3DModal({
  open,
  onOpenChange,
  stlFiles,
  initialStl,
}: ModelViewer3DModalProps) {
  const [activeStl, setActiveStl] = React.useState<StlFileRef | null>(initialStl);
  const [retry, setRetry] = React.useState(0);

  // Sync the active STL when the modal is (re)opened on a specific file.
  React.useEffect(() => {
    if (open) {
      setActiveStl(initialStl);
      setRetry(0);
    }
  }, [open, initialStl]);

  const activeIndex = activeStl
    ? stlFiles.findIndex((s) => s.relativePath === activeStl.relativePath)
    : -1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl w-[92vw] h-[85vh] p-0 gap-0 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border flex-shrink-0 pr-12">
          <Model3DIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <DialogTitle className="text-sm font-semibold text-foreground truncate">
            {activeStl?.name ?? '3D viewer'}
          </DialogTitle>
          {stlFiles.length > 1 && activeIndex >= 0 && (
            <span className="text-xs text-muted-foreground flex-shrink-0">
              {activeIndex + 1} of {stlFiles.length}
            </span>
          )}
        </div>

        {/* Canvas region */}
        <div
          className="relative flex-1 min-h-0"
          style={{ background: 'var(--ax-bg-sunk)' }}
        >
          {activeStl ? (
            <SceneErrorBoundary
              resetKey={`${activeStl.url}#${retry}`}
              onRetry={() => setRetry((r) => r + 1)}
            >
              <React.Suspense fallback={<ViewerLoading />}>
                <ModelViewer3DScene key={`${activeStl.url}#${retry}`} url={activeStl.url} />
              </React.Suspense>
            </SceneErrorBoundary>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              No 3D file selected
            </div>
          )}
        </div>

        {/* File switcher */}
        {stlFiles.length > 1 && (
          <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border overflow-x-auto flex-shrink-0">
            {stlFiles.map((stl) => {
              const isActive = stl.relativePath === activeStl?.relativePath;
              return (
                <button
                  key={stl.relativePath}
                  type="button"
                  onClick={() => setActiveStl(stl)}
                  aria-pressed={isActive}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-medium whitespace-nowrap transition-colors flex-shrink-0"
                  style={{
                    background: isActive ? 'var(--ax-amber)' : 'var(--ax-bg-elev)',
                    color: isActive ? 'var(--ax-amber-fg, white)' : 'var(--ax-fg-muted)',
                    border: '1px solid var(--ax-border)',
                  }}
                >
                  <Model3DIcon className="h-3.5 w-3.5" />
                  {stl.name}
                </button>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
