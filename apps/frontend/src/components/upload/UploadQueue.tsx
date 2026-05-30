import { Loader2, CheckCircle2, AlertCircle, Archive, BookOpen } from 'lucide-react';
import type { ImportSession } from '@alexandria/shared';
import { formatFileSize } from '../../lib/format';
import { cn } from '../../lib/utils';

interface UploadQueueProps {
  sessions: ImportSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
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
        <AlertCircle className="w-3 h-3" />
      </span>
    );
  }
  if (status === 'scanning') {
    return (
      <span
        className={cn(base, size)}
        style={{ background: 'var(--ax-warning)', color: 'white' }}
      >
        <Loader2 className="w-3 h-3 animate-spin" />
      </span>
    );
  }
  if (status === 'ready_for_review') {
    return (
      <span
        className={cn(base, size)}
        style={{ background: 'var(--ax-teal)', color: 'var(--ax-teal-fg)' }}
      >
        <Archive className="w-3 h-3" />
      </span>
    );
  }
  if (status === 'committing') {
    return (
      <span
        className={cn(base, size)}
        style={{ background: 'var(--ax-warning)', color: 'white' }}
      >
        <Loader2 className="w-3 h-3 animate-spin" />
      </span>
    );
  }
  // committed
  return (
    <span
      className={cn(base, size)}
      style={{ background: 'var(--ax-success)', color: 'white' }}
    >
      <CheckCircle2 className="w-3 h-3" />
    </span>
  );
}

function statusLabel(status: ImportSession['status']): string {
  switch (status) {
    case 'scanning': return 'Scanning…';
    case 'ready_for_review': return 'Ready to review';
    case 'committing': return 'Committing…';
    case 'committed': return 'Committed';
    case 'error': return 'Error';
  }
}

export function UploadQueue({ sessions, activeId, onSelect }: UploadQueueProps) {
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
          Upload queue
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
            No uploads yet. Drop an archive to start.
          </p>
        )}
        {sessions.map((session) => {
          const active = session.id === activeId;
          return (
            <button
              key={session.id}
              onClick={() => onSelect(session.id)}
              className="flex flex-col gap-1.5 w-full text-left px-3 py-2.5 rounded-lg mt-1 transition-colors"
              style={{
                background: active ? 'var(--ax-rail-elev)' : 'transparent',
                border: `1px solid ${active ? 'var(--ax-rail-border)' : 'transparent'}`,
                color: 'inherit',
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
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
                  <div
                    className="ax-mono text-[11px]"
                    style={{ color: 'var(--ax-rail-fg-muted)' }}
                  >
                    {session.detected
                      ? `${formatFileSize(session.detected.totalSizeBytes)} · ${session.detected.fileCount} files`
                      : statusLabel(session.status)}
                  </div>
                </div>
              </div>
              {session.status === 'error' && session.error && (
                <div className="text-[10.5px] pl-[34px]" style={{ color: '#fca5a5' }}>
                  {session.error}
                </div>
              )}
            </button>
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
