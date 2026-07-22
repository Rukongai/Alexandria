import { useState, useEffect, useRef, type KeyboardEvent } from 'react';
import { Files, FolderOpen } from 'lucide-react';
import {
  useAddSessionFiles,
  useDiscardSession,
  useImportSession,
  useImportSessions,
} from '../hooks/use-import-sessions';
import { useToast } from '../hooks/use-toast';
import { UploadQueue } from '../components/upload/UploadQueue';
import { DropZone } from '../components/upload/DropZone';
import { ReviewPane } from '../components/upload/ReviewPane';
import { FolderImport } from '../components/upload/FolderImport';
import { RecentUploads } from '../components/upload/RecentUploads';
import { MultipartArchiveUpload } from '../components/upload/multipart-archive-upload';
import { cn } from '../lib/utils';

type Tab = 'queue' | 'multipart' | 'folder';
const UPLOAD_TABS: Tab[] = ['queue', 'multipart', 'folder'];

export function UploadPage() {
  const { data: sessions = [] } = useImportSessions();
  const discardSession = useDiscardSession();
  const addSessionFiles = useAddSessionFiles();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    queue: null,
    multipart: null,
    folder: null,
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('queue');
  const [fileTargetId, setFileTargetId] = useState<string | null>(null);
  const [addFilesProgress, setAddFilesProgress] = useState(0);
  const { data: selectedSession } = useImportSession(activeId);

  // Prefer an actionable listed session, but retain a selected committing session
  // after listActive drops it so the terminal success state remains reachable.
  useEffect(() => {
    if (activeId && sessions.some((session) => session.id === activeId)) return;

    const preferred =
      sessions.find((s) => s.status === 'ready_for_review') ??
      sessions.find((s) => s.status !== 'committed') ??
      sessions[0] ??
      null;
    if (preferred && preferred.id !== activeId) setActiveId(preferred.id);
  }, [activeId, sessions]);

  const listedActiveSession = sessions.find((s) => s.id === activeId) ?? null;
  const activeSession = listedActiveSession ?? (sessions.length === 0 ? selectedSession ?? null : null);
  const discardingId = discardSession.isPending ? (discardSession.variables ?? null) : null;
  const addingFilesId = addSessionFiles.isPending
    ? (addSessionFiles.variables?.id ?? null)
    : null;

  const handleCommitted = (_modelId: string) => {
    // Session transitions to committing automatically via polling; nothing to do here
  };

  const handleDiscard = async (discardedId: string) => {
    if (discardSession.isPending) return;
    try {
      await discardSession.mutateAsync(discardedId);
      setActiveId((current) => current === discardedId ? null : current);
    } catch {
      toast({ title: 'Failed to discard upload', variant: 'destructive' });
    }
  };

  const chooseFilesForSession = (sessionId: string) => {
    setFileTargetId(sessionId);
    if (fileInputRef.current) fileInputRef.current.value = '';
    fileInputRef.current?.click();
  };

  const handleFilesSelected = async (files: File[]) => {
    if (!fileTargetId || files.length === 0 || addSessionFiles.isPending) return;
    setAddFilesProgress(0);
    try {
      await addSessionFiles.mutateAsync({
        id: fileTargetId,
        files,
        onProgress: setAddFilesProgress,
      });
      toast({
        title: `${files.length} file${files.length === 1 ? '' : 's'} added to queue`,
      });
    } catch (error) {
      toast({
        title: 'Failed to add files',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setFileTargetId(null);
      setAddFilesProgress(0);
    }
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentTab: Tab) => {
    const currentIndex = UPLOAD_TABS.indexOf(currentTab);
    let nextIndex: number | null = null;

    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % UPLOAD_TABS.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + UPLOAD_TABS.length) % UPLOAD_TABS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = UPLOAD_TABS.length - 1;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = UPLOAD_TABS[nextIndex];
    setTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        aria-label="Choose loose files for queued model"
        onChange={(event) => void handleFilesSelected(Array.from(event.currentTarget.files ?? []))}
      />
      {/* Left rail: queue */}
      <UploadQueue
        sessions={sessions}
        activeId={activeId}
        onSelect={(id) => { setActiveId(id); setTab('queue'); }}
        onDiscard={(id) => void handleDiscard(id)}
        onAddFiles={chooseFilesForSession}
        discardingId={discardingId}
        addingFilesId={addingFilesId}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Tab bar */}
        <div
          className="flex items-center gap-1 px-7 pt-4 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--ax-border)' }}
          role="tablist"
          aria-label="Upload method"
        >
          <button
            ref={(element) => { tabRefs.current.queue = element; }}
            id="upload-tab-archive"
            type="button"
            onClick={() => setTab('queue')}
            role="tab"
            aria-selected={tab === 'queue'}
            aria-controls="upload-panel-archive"
            tabIndex={tab === 'queue' ? 0 : -1}
            onKeyDown={(event) => handleTabKeyDown(event, 'queue')}
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
            ref={(element) => { tabRefs.current.multipart = element; }}
            id="upload-tab-multipart"
            type="button"
            onClick={() => setTab('multipart')}
            role="tab"
            aria-selected={tab === 'multipart'}
            aria-controls="upload-panel-multipart"
            tabIndex={tab === 'multipart' ? 0 : -1}
            onKeyDown={(event) => handleTabKeyDown(event, 'multipart')}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium rounded-t-lg border-b-2 transition-colors',
              tab === 'multipart'
                ? 'border-[var(--ax-amber)] text-[var(--ax-amber)]'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <Files className="h-3.5 w-3.5" />
            Multi-part archive
          </button>
          <button
            ref={(element) => { tabRefs.current.folder = element; }}
            id="upload-tab-folder"
            type="button"
            onClick={() => setTab('folder')}
            role="tab"
            aria-selected={tab === 'folder'}
            aria-controls="upload-panel-folder"
            tabIndex={tab === 'folder' ? 0 : -1}
            onKeyDown={(event) => handleTabKeyDown(event, 'folder')}
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
          <div
            id="upload-panel-folder"
            role="tabpanel"
            aria-labelledby="upload-tab-folder"
            className="flex-1 overflow-y-auto"
          >
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
        ) : tab === 'multipart' ? (
          <div
            id="upload-panel-multipart"
            role="tabpanel"
            aria-labelledby="upload-tab-multipart"
            className="flex-1 overflow-y-auto ax-scroll"
          >
            <MultipartArchiveUpload
              onSessionCreated={(sessionId) => {
                setActiveId(sessionId);
                setTab('queue');
                toast({ title: 'Archive group added to the review queue' });
              }}
            />
          </div>
        ) : (
          <div
            id="upload-panel-archive"
            role="tabpanel"
            aria-labelledby="upload-tab-archive"
            className="flex-1 overflow-hidden flex flex-col"
          >
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
                  onDiscard={() => void handleDiscard(activeSession.id)}
                  onRetry={() => void handleDiscard(activeSession.id)}
                  isDiscarding={discardingId === activeSession.id}
                  onAddFiles={() => chooseFilesForSession(activeSession.id)}
                  isAddingFiles={addingFilesId === activeSession.id}
                  addFilesProgress={addFilesProgress}
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
