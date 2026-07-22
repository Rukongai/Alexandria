import { useState, useEffect } from 'react';
import { FolderOpen } from 'lucide-react';
import { useDiscardSession, useImportSessions } from '../hooks/use-import-sessions';
import { useToast } from '../hooks/use-toast';
import { UploadQueue } from '../components/upload/UploadQueue';
import { DropZone } from '../components/upload/DropZone';
import { ReviewPane } from '../components/upload/ReviewPane';
import { FolderImport } from '../components/upload/FolderImport';
import { RecentUploads } from '../components/upload/RecentUploads';
import { cn } from '../lib/utils';

type Tab = 'queue' | 'folder';

export function UploadPage() {
  const { data: sessions = [] } = useImportSessions();
  const discardSession = useDiscardSession();
  const { toast } = useToast();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('queue');

  // Auto-select the first actionable (non-committed) session when the list loads
  useEffect(() => {
    if (activeId) {
      // Keep existing selection if it's still in the list
      const stillExists = sessions.some((s) => s.id === activeId);
      if (stillExists) return;
    }
    // Find first ready_for_review, then scanning, then any
    const preferred =
      sessions.find((s) => s.status === 'ready_for_review') ??
      sessions.find((s) => s.status !== 'committed') ??
      sessions[0] ??
      null;
    setActiveId(preferred?.id ?? null);
  }, [sessions]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  const handleCommitted = (_modelId: string) => {
    // Session transitions to committing automatically via polling; nothing to do here
  };

  const handleDiscard = async () => {
    if (!activeSession || discardSession.isPending) return;

    const discardedId = activeSession.id;
    try {
      await discardSession.mutateAsync(discardedId);
      setActiveId((current) => current === discardedId ? null : current);
    } catch {
      toast({ title: 'Failed to discard upload', variant: 'destructive' });
    }
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left rail: queue */}
      <UploadQueue
        sessions={sessions}
        activeId={activeId}
        onSelect={(id) => { setActiveId(id); setTab('queue'); }}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Tab bar */}
        <div
          className="flex items-center gap-1 px-7 pt-4 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--ax-border)' }}
        >
          <button
            onClick={() => setTab('queue')}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium rounded-t-lg border-b-2 transition-colors',
              tab === 'queue'
                ? 'border-[var(--ax-amber)] text-[var(--ax-amber)]'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            Archive upload
          </button>
          <button
            onClick={() => setTab('folder')}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium rounded-t-lg border-b-2 transition-colors',
              tab === 'folder'
                ? 'border-[var(--ax-amber)] text-[var(--ax-amber)]'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Server folder import
          </button>
        </div>

        {tab === 'folder' ? (
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-2xl mx-auto px-7 py-6">
              <div className="space-y-2 mb-6">
                <h1 className="text-xl font-bold" style={{ color: 'var(--ax-fg)' }}>
                  Import from server folder
                </h1>
                <p className="text-[13px]" style={{ color: 'var(--ax-fg-muted)' }}>
                  Point at a folder on the server and define how its hierarchy maps to
                  collections and metadata.
                </p>
              </div>
              <FolderImport />
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col">
            {/* Drop zone — compact when sessions exist, full when empty */}
            {sessions.length > 0 ? (
              <DropZone compact onBrowseFolder={() => setTab('folder')} />
            ) : (
              <div className="px-7 pt-6">
                <div className="space-y-2 mb-4">
                  <h1 className="text-xl font-bold" style={{ color: 'var(--ax-fg)' }}>
                    Add models
                  </h1>
                  <p className="text-[13px]" style={{ color: 'var(--ax-fg-muted)' }}>
                    Drop archives to scan, then review detected metadata before importing.
                  </p>
                </div>
                <DropZone />
              </div>
            )}

            {/* Review pane or empty state */}
            <div className="flex-1 overflow-y-auto ax-scroll px-7 py-5">
              {activeSession ? (
                <ReviewPane
                  session={activeSession}
                  onCommitted={handleCommitted}
                  onDiscard={handleDiscard}
                  onRetry={handleDiscard}
                  isDiscarding={discardSession.isPending}
                />
              ) : sessions.length === 0 ? (
                <div className="space-y-4 mt-4">
                  <h2 className="text-base font-semibold" style={{ color: 'var(--ax-fg)' }}>
                    Recent models
                  </h2>
                  <RecentUploads />
                </div>
              ) : (
                <div
                  className="flex flex-col items-center justify-center py-16 text-[13px]"
                  style={{ color: 'var(--ax-fg-muted)' }}
                >
                  Select a session from the queue to review it.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
