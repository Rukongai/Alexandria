import * as React from 'react';
import { AlertTriangle, Archive, Download, File, Folder, Loader2 } from 'lucide-react';
import type { ArchiveEntry } from '@alexandria/shared';
import { downloadModelArchiveEntry, getModelArchiveContents } from '../../api/models';
import { formatFileSize } from '../../lib/format';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';

interface ArchivePreviewTarget {
  fileId: string;
  name: string;
}

interface ArchivePreviewModalProps {
  modelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  archive: ArchivePreviewTarget | null;
}

type PreviewState =
  | { status: 'idle'; entries: [] }
  | { status: 'loading'; entries: [] }
  | { status: 'loaded'; entries: ArchiveEntry[] }
  | { status: 'error'; entries: []; message: string };

function entryName(entryPath: string): string {
  const segments = entryPath.split('/');
  return segments[segments.length - 1] ?? entryPath;
}

export function ArchivePreviewModal({
  modelId,
  open,
  onOpenChange,
  archive,
}: ArchivePreviewModalProps) {
  const [state, setState] = React.useState<PreviewState>({ status: 'idle', entries: [] });
  const [downloadingPath, setDownloadingPath] = React.useState<string | null>(null);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open || !archive) {
      setState({ status: 'idle', entries: [] });
      setDownloadingPath(null);
      setDownloadError(null);
      return;
    }

    const controller = new AbortController();
    setState({ status: 'loading', entries: [] });

    getModelArchiveContents(modelId, archive.fileId, controller.signal)
      .then((contents) => setState({ status: 'loaded', entries: contents.entries }))
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({
          status: 'error',
          entries: [],
          message: error instanceof Error ? error.message : 'Archive preview failed',
        });
      });

    return () => controller.abort();
  }, [archive, modelId, open]);

  async function downloadEntry(entryPath: string): Promise<void> {
    if (!archive) return;
    setDownloadingPath(entryPath);
    setDownloadError(null);
    try {
      const blob = await downloadModelArchiveEntry(modelId, archive.fileId, entryPath);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = entryName(entryPath);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : 'Download failed');
    } finally {
      setDownloadingPath(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[82vh] w-[92vw] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <div className="flex min-w-0 items-center gap-2 border-b border-border px-5 py-3 pr-12">
          <Archive className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <DialogTitle className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {archive?.name ?? 'Archive contents'}
          </DialogTitle>
          {state.status === 'loaded' && (
            <span className="flex-shrink-0 text-xs text-muted-foreground">
              {state.entries.filter((entry) => !entry.isDirectory).length} files
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-background">
          {downloadError && (
            <p className="border-b border-destructive/30 bg-destructive/5 px-5 py-2 text-xs text-destructive">
              Couldn&apos;t download file: {downloadError}
            </p>
          )}
          {state.status === 'loading' && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="h-7 w-7 animate-spin" />
              <span className="text-sm">Reading archive contents...</span>
            </div>
          )}

          {state.status === 'error' && (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
              <AlertTriangle className="h-8 w-8 text-destructive/70" />
              <p className="text-sm font-medium text-foreground">Couldn&apos;t read this archive</p>
              <p className="max-w-md text-xs">{state.message}</p>
            </div>
          )}

          {state.status === 'loaded' && state.entries.length === 0 && (
            <p className="p-5 text-sm text-muted-foreground">This archive is empty.</p>
          )}

          {state.status === 'loaded' && state.entries.length > 0 && (
            <ul className="p-2" aria-label="Archive contents">
              {state.entries.map((entry) => {
                const depth = entry.path.split('/').length - 1;
                return (
                  <li
                    key={entry.path}
                    className="group flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50"
                    style={{ paddingLeft: `${depth * 16 + 8}px` }}
                  >
                    {entry.isDirectory ? (
                      <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    ) : (
                      <File className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate" title={entry.path}>{entryName(entry.path)}</span>
                    {!entry.isDirectory && (
                      <>
                        <span className="flex-shrink-0 text-xs text-muted-foreground">
                          {formatFileSize(entry.sizeBytes)}
                        </span>
                        {archive && (
                          <button
                            type="button"
                            onClick={() => void downloadEntry(entry.path)}
                            disabled={downloadingPath !== null}
                            className="flex h-7 flex-shrink-0 items-center gap-1.5 rounded px-2 text-xs font-medium opacity-0 transition-opacity hover:bg-accent focus:opacity-100 group-hover:opacity-100 disabled:opacity-50"
                            aria-label={`Download ${entry.path}`}
                          >
                            <Download className="h-3.5 w-3.5" />
                            {downloadingPath === entry.path ? 'Downloading…' : 'Download'}
                          </button>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
