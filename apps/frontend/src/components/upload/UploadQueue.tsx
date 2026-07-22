import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  Archive,
  BookOpen,
  FilePlus2,
  Trash2,
} from 'lucide-react';
import type { ImportSession } from '@alexandria/shared';
import { formatFileSize } from '../../lib/format';
import { cn } from '../../lib/utils';
import { commitPhaseLabel, commitProgressValueText } from './UploadProgress';

interface UploadQueueProps {
  sessions: ImportSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDiscard: (id: string) => void;
  onAddFiles: (id: string) => void;
  discardingId: string | null;
  addingFilesId: string | null;
}

function StatusIcon({ status }: { status: ImportSession['status'] }) {
  const base = 'flex items-center justify-center rounded-md flex-shrink-0';
  const size = 'w-[26px] h-[26px]';

  if (status === 'error') {
    return (
      <span
        className={cn(base, size)}
        style={{ background: 'var(--ax-danger)', color: 'white' }}
      >
        <AlertCircle className="w-3 h-3" aria-hidden="true" />
      </span>
    );
  }
  if (status === 'scanning') {
    return (
      <span
        className={cn(base, size)}
        style={{ background: 'var(--ax-warning)', color: 'white' }}
      >
        <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      </span>
    );
  }
  if (status === 'ready_for_review') {
    return (
      <span
        className={cn(base, size)}
        style={{ background: 'var(--ax-teal)', color: 'var(--ax-teal-fg)' }}
      >
        <Archive className="w-3 h-3" aria-hidden="true" />
      </span>
    );
  }
  if (status === 'committing') {
    return (
      <span
        className={cn(base, size)}
        style={{ background: 'var(--ax-warning)', color: 'white' }}
      >
        <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      </span>
    );
  }
  // committed
  return (
    <span
      className={cn(base, size)}
      style={{ background: 'var(--ax-success)', color: 'white' }}
    >
      <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
    </span>
  );
}

function statusLabel(status: ImportSession['status']): string {
  switch (status) {
    case 'scanning': return 'Scanning…';
    case 'ready_for_review': return 'Ready to review';
    case 'committing': return 'Saving to library storage…';
    case 'committed': return 'Committed';
    case 'error': return 'Error';
  }
}

export function UploadQueue({
  sessions,
  activeId,
  onSelect,
  onDiscard,
  onAddFiles,
  discardingId,
  addingFilesId,
}: UploadQueueProps) {
  const totalSize = sessions.reduce((acc, s) => {
    return acc + (s.detected?.totalSizeBytes ?? 0);
  }, 0);
  const errorCount = sessions.filter((s) => s.status === 'error').length;
  const queuedCount = sessions.filter(
    (s) => s.status === 'scanning' || s.status === 'ready_for_review'
  ).length;

  return (
    <aside
      className="flex flex-col h-screen flex-shrink-0"
      style={{
        width: 300,
        background: 'var(--ax-rail)',
        color: 'var(--ax-rail-fg)',
        borderRight: '1px solid var(--ax-rail-border)',
      }}
    >
      {/* Header */}
      <div
        className="flex-shrink-0 px-4 py-3.5"
        style={{ borderBottom: '1px solid var(--ax-rail-border)' }}
      >
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--ax-amber)' }} />
          <span
            className="font-semibold text-sm truncate"
            style={{ color: 'var(--ax-rail-fg)' }}
          >
            Alexandria
          </span>
          <span
            className="ax-mono ml-auto text-[11px]"
            style={{ color: 'var(--ax-rail-fg-muted)' }}
          >
            upload
          </span>
        </div>
      </div>

      {/* Queue label */}
      <div className="flex items-center justify-between px-3 pt-3.5 pb-2">
        <span
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--ax-rail-fg-muted)', letterSpacing: '0.06em' }}
        >
          Import queue
        </span>
        <span className="ax-mono text-[11px]" style={{ color: 'var(--ax-rail-fg-muted)' }}>
          {sessions.length}
        </span>
      </div>

      {/* Session list */}
      <div className="ax-scroll flex-1 overflow-y-auto px-2 pb-3">
        {sessions.length === 0 && (
          <p
            className="text-[12px] text-center py-8"
            style={{ color: 'var(--ax-rail-fg-muted)' }}
          >
            No imports yet. Drop an archive to start.
          </p>
        )}
        {sessions.map((session) => {
          const active = session.id === activeId;
          const canDiscard = session.status !== 'committing' && session.status !== 'committed';
          const canAddFiles = session.status === 'ready_for_review';
          const isDiscarding = session.id === discardingId;
          const isAddingFiles = session.id === addingFilesId;
          return (
            <div
              key={session.id}
              className="group flex w-full flex-col rounded-lg mt-1 transition-colors"
              style={{
                background: active ? 'var(--ax-rail-elev)' : 'transparent',
                border: `1px solid ${active ? 'var(--ax-rail-border)' : 'transparent'}`,
                color: 'inherit',
              }}
            >
              <div className="flex w-full items-start">
                <button
                  type="button"
                  onClick={() => onSelect(session.id)}
                  className="flex min-w-0 flex-1 flex-col gap-1.5 px-3 py-2.5 text-left"
                  style={{ color: 'inherit', fontFamily: 'inherit' }}
                >
                  <div className="flex items-center gap-2">
                    <StatusIcon status={session.status} />
                    <div className="flex-1 min-w-0">
                      <div
                        className="ax-code text-[12px] font-medium truncate"
                        style={{ color: 'var(--ax-rail-fg)' }}
                      >
                        {session.originalFilename}
                      </div>
                      {session.status !== 'committing' && (
                        <div
                          className="ax-mono text-[11px]"
                          style={{ color: 'var(--ax-rail-fg-muted)' }}
                        >
                          {session.detected
                            ? `${formatFileSize(session.detected.totalSizeBytes)} · ${session.detected.fileCount} files`
                            : statusLabel(session.status)}
                        </div>
                      )}
                    </div>
                  </div>
                  {session.status === 'error' && session.error && (
                    <div className="text-[10.5px] pl-[34px]" style={{ color: '#fca5a5' }}>
                      {session.error}
                    </div>
                  )}
                </button>
                {canAddFiles && (
                  <button
                    type="button"
                    onClick={() => onAddFiles(session.id)}
                    disabled={addingFilesId !== null || discardingId !== null}
                    className="my-2 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--ax-rail-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ color: 'var(--ax-rail-fg-muted)' }}
                    aria-label={`Add files to ${session.originalFilename}`}
                    title={`Add files to ${session.originalFilename}`}
                  >
                    {isAddingFiles ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FilePlus2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
                {canDiscard && (
                  <button
                    type="button"
                    onClick={() => onDiscard(session.id)}
                    disabled={discardingId !== null}
                    className="m-2 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--ax-rail-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ color: 'var(--ax-rail-fg-muted)' }}
                    aria-label={`Discard ${session.originalFilename}`}
                    title={`Discard ${session.originalFilename}`}
                  >
                    {isDiscarding ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
              </div>
              {session.status === 'committing' && (
                <CommitQueueProgress session={session} />
              )}
            </div>
          );
        })}
      </div>

      {/* Stats footer */}
      <div
        className="flex-shrink-0 grid grid-cols-2 gap-3 px-4 py-3"
        style={{ borderTop: '1px solid var(--ax-rail-border)' }}
      >
        <StatCell label="Queued" value={String(queuedCount)} />
        <StatCell label="Total size" value={totalSize > 0 ? formatFileSize(totalSize) : '—'} />
        <StatCell
          label="Errors"
          value={String(errorCount)}
          danger={errorCount > 0}
        />
        <StatCell label="Done" value={String(sessions.filter((s) => s.status === 'committed').length)} />
      </div>
    </aside>
  );
}

function CommitQueueProgress({ session }: { session: ImportSession }) {
  const progress = session.commitProgress;

  if (!progress) {
    return (
      <div className="space-y-1 px-3 pb-2.5 pl-[46px]">
        <div
          className="text-[11px]"
          style={{ color: 'var(--ax-rail-fg-muted)' }}
          role="status"
        >
          Saving to library storage…
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full"
          style={{ background: 'var(--ax-rail-hover)' }}
          role="progressbar"
          aria-label={`Saving ${session.originalFilename} to library storage`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext="Saving to library storage"
        >
          <div
            className="h-full w-1/3 rounded-full animate-[slide_1.5s_ease-in-out_infinite] motion-reduce:animate-none"
            style={{ background: 'var(--ax-amber)' }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1 px-3 pb-2.5 pl-[46px]">
      <div className="flex items-center justify-between gap-2 text-[10.5px]">
        <span className="truncate" style={{ color: 'var(--ax-rail-fg-muted)' }}>
          {commitPhaseLabel(progress.phase)}
        </span>
        <span
          className="ax-mono flex-shrink-0 tabular-nums"
          style={{ color: 'var(--ax-rail-fg-muted)' }}
        >
          {progress.percent}%
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full"
        style={{ background: 'var(--ax-rail-hover)' }}
        role="progressbar"
        aria-label={`Saving ${session.originalFilename} to library storage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-valuetext={commitProgressValueText(progress)}
      >
        <div
          className="h-full rounded-full transition-all duration-500 motion-reduce:transition-none"
          style={{ width: `${progress.percent}%`, background: 'var(--ax-amber)' }}
        />
      </div>
      <div
        className="ax-mono flex items-center justify-between gap-2 text-[10px] tabular-nums"
        style={{ color: 'var(--ax-rail-fg-muted)' }}
      >
        <span>
          {formatFileSize(progress.completedBytes)} / {formatFileSize(progress.totalBytes)}
        </span>
        <span>
          {progress.completedFiles} / {progress.totalFiles} files
        </span>
      </div>
      {progress.currentFilename && (
        <p
          className="truncate font-mono text-[10px]"
          style={{ color: 'var(--ax-rail-fg-muted)' }}
          title={progress.currentFilename}
        >
          {progress.currentFilename}
        </p>
      )}
    </div>
  );
}

function StatCell({
  label,
  value,
  danger,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div>
      <div
        className="ax-mono text-[17px] font-bold"
        style={{
          color: danger ? '#fca5a5' : 'var(--ax-rail-fg)',
          letterSpacing: '-0.01em',
        }}
      >
        {value}
      </div>
      <div
        className="text-[10px] font-semibold uppercase mt-0.5"
        style={{
          color: 'var(--ax-rail-fg-muted)',
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </div>
    </div>
  );
}
