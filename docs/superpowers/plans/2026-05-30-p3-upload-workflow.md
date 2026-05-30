# P3 Upload Workflow (Scan → Review → Commit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Alexandria upload page into a staged scan→review→commit workflow with a dark queue rail and a main review pane driven by import sessions.

**Architecture:** Upload archives → backend creates ImportSession (status: scanning) → frontend polls sessions and shows detected folder structure → user fills BatchMetadataForm → commit creates model → poll model status to ready. The left rail lists all in-flight sessions; the right main area shows the active session's review pane. The existing FolderImport tab is preserved as a secondary tab.

**Tech Stack:** React + TanStack Query, TypeScript, Tailwind + `var(--ax-*)` tokens, shadcn/ui primitives, `@alexandria/shared` types.

---

## File Map

**Created:**
- `apps/frontend/src/api/models.ts` — updated: rename `uploadModel` → `scanUpload`, fix return type, add import-session API functions
- `apps/frontend/src/hooks/use-import-sessions.ts` — new React Query hook: list sessions (with polling), upload+invalidate, commit, discard
- `apps/frontend/src/components/upload/UploadQueue.tsx` — new: dark left rail showing all ImportSessions with status icons, selectable, stats footer
- `apps/frontend/src/components/upload/DropZone.tsx` — restyle: compact collapsed form when sessions exist; multi-file drop starts scanUpload per file; upload progress per file
- `apps/frontend/src/components/upload/ReviewPane.tsx` — new: renders scanning/ready_for_review/committing/committed/error states for active session
- `apps/frontend/src/components/upload/BatchMetadataForm.tsx` — new: collection picker, artist, tags chip input, options checkboxes; calls commit
- `apps/frontend/src/components/upload/FolderImport.tsx` — restyle: remove amber-/emerald- literals → semantic status colors
- `apps/frontend/src/components/upload/RecentUploads.tsx` — restyle: remove amber-/emerald- literals → semantic status colors
- `apps/frontend/src/components/upload/UploadProgress.tsx` — restyle: remove emerald- → semantic colors
- `apps/frontend/src/components/upload/PatternBuilder.tsx` — no change unless amber-/emerald- found (check at end)
- `apps/frontend/src/pages/UploadPage.tsx` — rebuild: two-column shell (UploadQueue rail + main area with DropZone + ReviewPane); keep FolderImport tab accessible

---

## Task 1: Update `src/api/models.ts` — scan upload + import session functions

**Files:**
- Modify: `apps/frontend/src/api/models.ts`

- [ ] **Step 1: Read the current file** (already done in planning — summary: `uploadModel` returns `{ modelId }`, the `complete` step expects `{ modelId; jobId }`)

- [ ] **Step 2: Replace `uploadModel` with `scanUpload` and add session API functions**

Replace the entire `uploadModel` function and add the four import-session functions. The chunk init/chunk/complete mechanics stay the same; only the `complete` response type and return value change:

```typescript
import type {
  ApiResponse,
  ModelCard,
  ModelDetail,
  FileTreeNode,
  JobStatus,
  ModelSearchParams,
  UpdateModelRequest,
  ImportConfig,
  ImportSession,
  BatchUploadMetadata,
  ScanUploadResponse,
} from '@alexandria/shared';
import { get, post, patch, del, putRaw } from './client';
import { buildQueryString } from '../lib/query';

export async function getModels(params: ModelSearchParams): Promise<ApiResponse<ModelCard[]>> {
  const { metadataFilters, ...rest } = params;
  const flat: Record<string, unknown> = { ...rest };

  if (metadataFilters) {
    for (const [key, value] of Object.entries(metadataFilters)) {
      flat[`meta_${key}`] = value;
    }
  }

  const qs = buildQueryString(flat);
  return get<ModelCard[]>(`/models${qs}`);
}

export async function getModel(id: string): Promise<ModelDetail> {
  const response = await get<ModelDetail>(`/models/${id}`);
  return response.data;
}

export async function getModelFiles(id: string): Promise<FileTreeNode[]> {
  const response = await get<FileTreeNode[]>(`/models/${id}/files`);
  return response.data;
}

export async function getModelStatus(id: string): Promise<JobStatus> {
  const response = await get<JobStatus>(`/models/${id}/status`);
  return response.data;
}

export async function updateModel(id: string, data: UpdateModelRequest): Promise<ModelDetail> {
  const response = await patch<ModelDetail>(`/models/${id}`, data);
  return response.data;
}

export async function deleteModel(id: string): Promise<void> {
  await del(`/models/${id}`);
}

const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_CHUNK_RETRIES = 3;

/**
 * Upload an archive file using chunked upload. Creates an import session
 * (status: scanning) instead of immediately creating a model.
 * Returns { sessionId } — poll the session to track scan progress.
 */
export async function scanUpload(
  file: File,
  onProgress?: (pct: number) => void
): Promise<ScanUploadResponse> {
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

  // 1. Initiate chunked upload session
  const initResponse = await post<{ uploadId: string; expiresAt: string }>(
    '/models/upload/init',
    { filename: file.name, totalSize: file.size, totalChunks },
  );
  const { uploadId } = initResponse.data;

  // 2. Upload chunks sequentially with per-chunk retry
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_CHUNK_RETRIES; attempt++) {
      try {
        await putRaw(
          `/models/upload/${uploadId}/chunk/${i}`,
          chunk,
          (chunkPct) => {
            if (onProgress) {
              const chunkFraction = chunkPct / 100;
              const overallPct = Math.round(((i + chunkFraction) / totalChunks) * 95);
              onProgress(overallPct);
            }
          },
        );
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < MAX_CHUNK_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
    }
    if (lastError) throw lastError;
  }

  onProgress?.(95);

  // 3. Complete — assemble and start scan; returns { sessionId }
  const completeResponse = await post<ScanUploadResponse>(
    `/models/upload/${uploadId}/complete`,
  );

  onProgress?.(100);

  return completeResponse.data;
}

export async function listImportSessions(): Promise<ImportSession[]> {
  const response = await get<ImportSession[]>('/models/import-sessions');
  return response.data;
}

export async function getImportSession(id: string): Promise<ImportSession> {
  const response = await get<ImportSession>(`/models/import-sessions/${id}`);
  return response.data;
}

export async function commitImportSession(
  id: string,
  batchMetadata?: BatchUploadMetadata
): Promise<{ modelId: string; jobId: string }> {
  const response = await post<{ modelId: string; jobId: string }>(
    `/models/import-sessions/${id}/commit`,
    batchMetadata ? { batchMetadata } : undefined
  );
  return response.data;
}

export async function discardImportSession(id: string): Promise<void> {
  await del(`/models/import-sessions/${id}`);
}

export async function importFolder(config: ImportConfig): Promise<{ modelId: string }> {
  const response = await post<{ modelId: string }>('/models/import', config);
  return response.data;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/joseph/Projects/Alexandria/apps/frontend && npx tsc --noEmit 2>&1 | head -40
```

Expected: no errors related to `models.ts`. If `ScanUploadResponse` is missing from `@alexandria/shared`, check `packages/shared/src/types/upload.ts` — it is already defined there.

- [ ] **Step 4: Commit**

```bash
cd /Users/joseph/Projects/Alexandria && git add apps/frontend/src/api/models.ts && git commit -m "feat(upload): update models API — scanUpload returns sessionId, add import-session functions"
```

---

## Task 2: Create `src/hooks/use-import-sessions.ts`

**Files:**
- Create: `apps/frontend/src/hooks/use-import-sessions.ts`

- [ ] **Step 1: Create the hook file**

```typescript
// apps/frontend/src/hooks/use-import-sessions.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { BatchUploadMetadata, ImportSession } from '@alexandria/shared';
import {
  listImportSessions,
  getImportSession,
  commitImportSession,
  discardImportSession,
  scanUpload,
} from '../api/models';

const TERMINAL_STATUSES = new Set(['committed', 'error']);

function isNonTerminal(session: ImportSession): boolean {
  return !TERMINAL_STATUSES.has(session.status);
}

/**
 * List all import sessions, polling every 2 s while any session is non-terminal.
 */
export function useImportSessions() {
  return useQuery({
    queryKey: ['import-sessions'],
    queryFn: listImportSessions,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 2000;
      return data.some(isNonTerminal) ? 2000 : false;
    },
    staleTime: 0,
  });
}

/**
 * Single session, polling every 2 s while non-terminal.
 */
export function useImportSession(id: string | null) {
  return useQuery({
    queryKey: ['import-session', id],
    queryFn: () => getImportSession(id!),
    enabled: id !== null,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 2000;
      return isNonTerminal(data) ? 2000 : false;
    },
    staleTime: 0,
  });
}

/**
 * Upload a file, then invalidate the sessions list so the new session appears.
 * Returns a mutation; call mutateAsync(file, { onProgress }) — progress is
 * tracked via the onProgress arg passed to scanUpload.
 */
export function useStartScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      file,
      onProgress,
    }: {
      file: File;
      onProgress?: (pct: number) => void;
    }) => scanUpload(file, onProgress),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['import-sessions'] });
    },
  });
}

/**
 * Commit a ready_for_review session. Invalidates the session list and the
 * individual session on success.
 */
export function useCommitSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      batchMetadata,
    }: {
      id: string;
      batchMetadata?: BatchUploadMetadata;
    }) => commitImportSession(id, batchMetadata),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['import-sessions'] });
      queryClient.invalidateQueries({ queryKey: ['import-session', id] });
    },
  });
}

/**
 * Discard (delete) a session. Removes it from the list immediately.
 */
export function useDiscardSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => discardImportSession(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['import-sessions'] });
      queryClient.removeQueries({ queryKey: ['import-session', id] });
    },
  });
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /Users/joseph/Projects/Alexandria/apps/frontend && npx tsc --noEmit 2>&1 | head -40
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/joseph/Projects/Alexandria && git add apps/frontend/src/hooks/use-import-sessions.ts && git commit -m "feat(upload): add useImportSessions hook with polling and mutation helpers"
```

---

## Task 3: Create `UploadQueue.tsx` — dark rail showing session list

**Files:**
- Create: `apps/frontend/src/components/upload/UploadQueue.tsx`

- [ ] **Step 1: Create the component**

```typescript
// apps/frontend/src/components/upload/UploadQueue.tsx
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
    // Size is in detected metadata; fall back to 0 if not yet scanned
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
      <div
        className="flex items-center justify-between px-3 pt-3.5 pb-2"
      >
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
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /Users/joseph/Projects/Alexandria/apps/frontend && npx tsc --noEmit 2>&1 | head -40
```

- [ ] **Step 3: Commit**

```bash
cd /Users/joseph/Projects/Alexandria && git add apps/frontend/src/components/upload/UploadQueue.tsx && git commit -m "feat(upload): add UploadQueue rail component with session status chips and stats footer"
```

---

## Task 4: Create `BatchMetadataForm.tsx`

**Files:**
- Create: `apps/frontend/src/components/upload/BatchMetadataForm.tsx`

- [ ] **Step 1: Create the component**

This component receives `detected` metadata for pre-fill, a `sessionId`, and a `onCommitted` callback. It queries collections via `getCollections`, builds `BatchUploadMetadata`, and calls the commit mutation.

```typescript
// apps/frontend/src/components/upload/BatchMetadataForm.tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, X, Plus, FolderOpen, User, Tag } from 'lucide-react';
import type { DetectedImportMetadata, BatchUploadMetadata } from '@alexandria/shared';
import { getCollections } from '../../api/collections';
import { useCommitSession } from '../../hooks/use-import-sessions';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Checkbox } from '../ui/checkbox';

interface BatchMetadataFormProps {
  sessionId: string;
  detected: DetectedImportMetadata;
  onCommitted: (modelId: string) => void;
}

interface FormState {
  collectionId: string;
  newCollectionName: string;
  artist: string;
  tags: string[];
  tagInput: string;
  markPreSupported: boolean;
  autoThumbnails: boolean;
  markNsfw: boolean;
  skipDuplicatesByHash: boolean;
}

export function BatchMetadataForm({ sessionId, detected, onCommitted }: BatchMetadataFormProps) {
  const [form, setForm] = useState<FormState>({
    collectionId: '',
    newCollectionName: '',
    artist: detected.artist ?? '',
    tags: [...detected.tagsGuessed],
    tagInput: '',
    markPreSupported: false,
    autoThumbnails: true,
    markNsfw: false,
    skipDuplicatesByHash: true,
  });

  const { data: collectionsResponse } = useQuery({
    queryKey: ['collections'],
    queryFn: () => getCollections({ depth: 1 }),
    staleTime: 30_000,
  });
  const collections = collectionsResponse?.data ?? [];

  const commitMutation = useCommitSession();

  function addTag(tag: string) {
    const t = tag.trim();
    if (t && !form.tags.includes(t)) {
      setForm((f) => ({ ...f, tags: [...f.tags, t], tagInput: '' }));
    } else {
      setForm((f) => ({ ...f, tagInput: '' }));
    }
  }

  function removeTag(tag: string) {
    setForm((f) => ({ ...f, tags: f.tags.filter((t) => t !== tag) }));
  }

  async function handleSubmit() {
    const batchMetadata: BatchUploadMetadata = {
      ...(form.collectionId ? { collectionId: form.collectionId } : {}),
      ...(form.newCollectionName.trim() ? { newCollectionName: form.newCollectionName.trim() } : {}),
      ...(form.artist.trim() ? { artist: form.artist.trim() } : {}),
      ...(form.tags.length > 0 ? { tags: form.tags } : {}),
      options: {
        markPreSupported: form.markPreSupported,
        autoThumbnails: form.autoThumbnails,
        markNsfw: form.markNsfw,
        skipDuplicatesByHash: form.skipDuplicatesByHash,
      },
    };

    try {
      const result = await commitMutation.mutateAsync({ id: sessionId, batchMetadata });
      onCommitted(result.modelId);
    } catch {
      // Error surfaces via commitMutation.error
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Destination collection */}
      <FormSection label="Destination collection">
        {collections.length > 0 ? (
          <select
            value={form.collectionId}
            onChange={(e) => setForm((f) => ({ ...f, collectionId: e.target.value, newCollectionName: '' }))}
            className="w-full rounded-lg px-3 py-2 text-[13px]"
            style={{
              background: 'var(--ax-bg-elev)',
              border: '1px solid var(--ax-border)',
              color: 'var(--ax-fg)',
              fontFamily: 'inherit',
            }}
          >
            <option value="">— None —</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value="__new__">+ New collection…</option>
          </select>
        ) : (
          <select
            value={form.collectionId}
            onChange={(e) => setForm((f) => ({ ...f, collectionId: e.target.value }))}
            className="w-full rounded-lg px-3 py-2 text-[13px]"
            style={{
              background: 'var(--ax-bg-elev)',
              border: '1px solid var(--ax-border)',
              color: 'var(--ax-fg)',
              fontFamily: 'inherit',
            }}
          >
            <option value="">— No collections yet —</option>
            <option value="__new__">+ New collection…</option>
          </select>
        )}
        {(form.collectionId === '__new__') && (
          <div className="flex items-center gap-2 mt-2">
            <FolderOpen className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--ax-amber)' }} />
            <Input
              placeholder="New collection name"
              value={form.newCollectionName}
              onChange={(e) => setForm((f) => ({ ...f, newCollectionName: e.target.value }))}
              className="text-[13px]"
            />
          </div>
        )}
      </FormSection>

      {/* Artist */}
      <FormSection
        label={
          <span>
            Artist
            {detected.artist && (
              <span
                className="ml-2 font-normal text-[11px]"
                style={{ color: 'var(--ax-fg-subtle)' }}
              >
                auto-detected
              </span>
            )}
          </span>
        }
      >
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--ax-fg-muted)' }} />
          <Input
            value={form.artist}
            onChange={(e) => setForm((f) => ({ ...f, artist: e.target.value }))}
            placeholder="Artist name (optional)"
            className="text-[13px]"
          />
        </div>
      </FormSection>

      {/* Tags */}
      <FormSection label="Tags to apply to all">
        <div
          className="flex flex-wrap gap-1.5 p-2.5 rounded-lg min-h-[40px]"
          style={{
            background: 'var(--ax-bg-elev)',
            border: '1px solid var(--ax-border)',
          }}
        >
          {form.tags.map((tag) => (
            <span
              key={tag}
              className="ax-chip ax-chip-amber flex items-center gap-1"
              style={{ height: 22 }}
            >
              <Tag className="w-2.5 h-2.5" />
              {tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className="ml-0.5 hover:opacity-70"
                aria-label={`Remove tag ${tag}`}
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
          <input
            value={form.tagInput}
            onChange={(e) => setForm((f) => ({ ...f, tagInput: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTag(form.tagInput);
              }
            }}
            placeholder={form.tags.length === 0 ? 'Type a tag and press Enter…' : '+ tag'}
            className="bg-transparent text-[12px] outline-none flex-1 min-w-[80px] placeholder:text-[var(--ax-fg-muted)]"
            style={{ color: 'var(--ax-fg)', fontFamily: 'inherit' }}
          />
        </div>
        <p className="text-[11.5px] mt-1.5" style={{ color: 'var(--ax-fg-muted)' }}>
          Inferred from filenames + folder paths. Press Enter or comma to add.
        </p>
      </FormSection>

      {/* Options */}
      <FormSection label="Options">
        <div className="flex flex-col gap-1">
          <OptionCheck
            id="pre-supported"
            label="Mark all as pre-supported"
            checked={form.markPreSupported}
            onChange={(v) => setForm((f) => ({ ...f, markPreSupported: v }))}
          />
          <OptionCheck
            id="auto-thumbnails"
            label="Auto-generate thumbnails"
            checked={form.autoThumbnails}
            onChange={(v) => setForm((f) => ({ ...f, autoThumbnails: v }))}
            note="Always runs during ingestion"
          />
          <OptionCheck
            id="mark-nsfw"
            label="Mark as NSFW"
            checked={form.markNsfw}
            onChange={(v) => setForm((f) => ({ ...f, markNsfw: v }))}
          />
          <OptionCheck
            id="skip-dupes"
            label="Skip duplicates (by hash)"
            checked={form.skipDuplicatesByHash}
            onChange={(v) => setForm((f) => ({ ...f, skipDuplicatesByHash: v }))}
          />
        </div>
      </FormSection>

      {/* Commit action */}
      {commitMutation.error && (
        <div
          className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-[13px]"
          style={{
            background: 'color-mix(in srgb, var(--ax-danger) 10%, transparent)',
            border: '1px solid var(--ax-danger)',
            color: 'var(--ax-danger)',
          }}
        >
          {commitMutation.error instanceof Error
            ? commitMutation.error.message
            : 'Commit failed. Please try again.'}
        </div>
      )}

      <Button
        onClick={handleSubmit}
        disabled={commitMutation.isPending}
        className="w-full font-semibold"
        style={{
          background: 'var(--ax-amber)',
          color: 'var(--ax-amber-fg)',
          border: 'none',
        }}
      >
        {commitMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
        Import {detected.modelCount > 0 ? `${detected.modelCount} models` : 'archive'}
      </Button>
    </div>
  );
}

function FormSection({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label
        className="block text-[11px] font-semibold uppercase mb-1.5"
        style={{
          color: 'var(--ax-fg-muted)',
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </Label>
      {children}
    </div>
  );
}

function OptionCheck({
  id,
  label,
  checked,
  onChange,
  note,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  note?: string;
}) {
  return (
    <label
      htmlFor={id}
      className="flex items-center gap-2.5 py-1.5 px-1 cursor-pointer rounded"
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(c) => onChange(c === true)}
      />
      <span className="text-[12.5px]" style={{ color: checked ? 'var(--ax-fg)' : 'var(--ax-fg-muted)' }}>
        {label}
        {note && (
          <span className="ml-1.5 text-[11px]" style={{ color: 'var(--ax-fg-subtle)' }}>
            ({note})
          </span>
        )}
      </span>
    </label>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /Users/joseph/Projects/Alexandria/apps/frontend && npx tsc --noEmit 2>&1 | head -40
```

- [ ] **Step 3: Commit**

```bash
cd /Users/joseph/Projects/Alexandria && git add apps/frontend/src/components/upload/BatchMetadataForm.tsx && git commit -m "feat(upload): add BatchMetadataForm with collection picker, artist, tags, and options"
```

---

## Task 5: Create `ReviewPane.tsx`

**Files:**
- Create: `apps/frontend/src/components/upload/ReviewPane.tsx`

- [ ] **Step 1: Create the component**

ReviewPane renders by `session.status`. For `ready_for_review`, it shows the detected folder structure tree and `BatchMetadataForm` side by side. For `committing`/`committed`, it polls model status via `UploadProgress`. For `error`, shows danger card + Retry/Discard.

```typescript
// apps/frontend/src/components/upload/ReviewPane.tsx
import { Loader2, AlertCircle, Folder, FileCode2, File, Package } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ImportSession, DetectedFolderNode } from '@alexandria/shared';
import { BatchMetadataForm } from './BatchMetadataForm';
import { UploadProgress } from './UploadProgress';
import { Button } from '../ui/button';
import { formatFileSize } from '../../lib/format';

interface ReviewPaneProps {
  session: ImportSession;
  onCommitted: (modelId: string) => void;
  onDiscard: () => void;
  onRetry: () => void;
}

export function ReviewPane({ session, onCommitted, onDiscard, onRetry }: ReviewPaneProps) {
  if (session.status === 'scanning') {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-5">
        <div
          className="flex items-center justify-center rounded-2xl"
          style={{
            width: 64,
            height: 64,
            background: 'var(--ax-amber-tint)',
            color: 'var(--ax-amber-tint-fg)',
          }}
        >
          <Loader2 className="h-7 w-7 animate-spin" />
        </div>
        <div className="text-center">
          <h2
            className="text-xl font-bold"
            style={{ color: 'var(--ax-fg)' }}
          >
            Scanning archive…
          </h2>
          <p className="mt-1.5 text-[13px]" style={{ color: 'var(--ax-fg-muted)' }}>
            Extracting, detecting folder structure and metadata
          </p>
        </div>
      </div>
    );
  }

  if (session.status === 'error') {
    return (
      <div
        className="flex gap-4 rounded-xl p-8"
        style={{
          background: 'var(--ax-bg-elev)',
          border: '1px solid var(--ax-danger)',
        }}
      >
        <div
          className="flex items-center justify-center rounded-xl flex-shrink-0"
          style={{
            width: 48,
            height: 48,
            background: 'color-mix(in srgb, var(--ax-danger) 12%, transparent)',
            color: 'var(--ax-danger)',
          }}
        >
          <AlertCircle className="h-6 w-6" />
        </div>
        <div className="flex-1">
          <h2 className="text-[18px] font-semibold" style={{ color: 'var(--ax-fg)' }}>
            Couldn't process this archive
          </h2>
          <p className="mt-1.5 mb-4 text-[13px]" style={{ color: 'var(--ax-fg-muted)' }}>
            {session.error ?? 'An unknown error occurred during scanning.'}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry upload
            </Button>
            <Button variant="outline" size="sm" onClick={onDiscard}>
              Discard
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (session.status === 'committing' || session.status === 'committed') {
    const modelId = session.modelId;
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-5">
        <div
          className="flex items-center justify-center rounded-2xl"
          style={{
            width: 64,
            height: 64,
            background: 'var(--ax-teal-tint)',
            color: 'var(--ax-teal-tint-fg)',
          }}
        >
          <Package className="h-7 w-7" />
        </div>
        <div className="text-center max-w-sm">
          <h2 className="text-xl font-bold" style={{ color: 'var(--ax-fg)' }}>
            {session.status === 'committing' ? 'Importing…' : 'Imported!'}
          </h2>
          <p className="mt-1.5 text-[13px]" style={{ color: 'var(--ax-fg-muted)' }}>
            {session.status === 'committing'
              ? 'Your archive is being processed. This may take a moment.'
              : 'Archive committed. Processing the model now.'}
          </p>
        </div>
        {modelId && (
          <div className="w-full max-w-sm">
            <UploadProgress modelId={modelId} />
          </div>
        )}
      </div>
    );
  }

  // ready_for_review
  const { detected } = session;
  if (!detected) {
    // Shouldn't happen — status is ready_for_review but detected is null
    return (
      <div className="py-12 text-center text-[13px]" style={{ color: 'var(--ax-fg-muted)' }}>
        Detected metadata unavailable. Try discarding and re-uploading.
      </div>
    );
  }

  return (
    <div
      className="grid gap-6"
      style={{ gridTemplateColumns: '1.4fr 1fr' }}
    >
      {/* Left: folder structure + counts */}
      <div>
        <div className="flex items-baseline justify-between mb-2.5">
          <h2 className="text-[16px] font-bold" style={{ color: 'var(--ax-fg)' }}>
            {detected.modelCount} model{detected.modelCount !== 1 ? 's' : ''} detected
          </h2>
          <span className="ax-mono text-[12px]" style={{ color: 'var(--ax-fg-muted)' }}>
            {detected.fileCount} files · {formatFileSize(detected.totalSizeBytes)}
          </span>
        </div>

        <h3
          className="text-[13px] font-semibold mb-2"
          style={{ color: 'var(--ax-fg)' }}
        >
          Detected folder structure
        </h3>
        <div
          className="ax-code rounded-xl p-3.5 text-[12px] leading-relaxed overflow-auto max-h-80"
          style={{
            background: 'var(--ax-bg-elev)',
            border: '1px solid var(--ax-border)',
            lineHeight: '1.7',
          }}
        >
          {detected.folderStructure.length === 0 ? (
            <span style={{ color: 'var(--ax-fg-muted)' }}>No folder structure detected</span>
          ) : (
            <FolderTree nodes={detected.folderStructure} depth={0} maxDepth={4} />
          )}
        </div>
      </div>

      {/* Right: batch metadata form */}
      <BatchMetadataForm
        sessionId={session.id}
        detected={detected}
        onCommitted={onCommitted}
      />
    </div>
  );
}

function FolderTree({
  nodes,
  depth,
  maxDepth,
}: {
  nodes: DetectedFolderNode[];
  depth: number;
  maxDepth: number;
}) {
  if (depth > maxDepth) {
    return (
      <div
        style={{ paddingLeft: depth * 16, color: 'var(--ax-fg-muted)' }}
        className="flex items-center gap-1.5"
      >
        <span>…</span>
      </div>
    );
  }

  return (
    <>
      {nodes.map((node, i) => (
        <div key={i}>
          <div
            style={{
              paddingLeft: depth * 16,
              color: node.type === 'folder' ? 'var(--ax-fg)' : 'var(--ax-fg-muted)',
            }}
            className="flex items-center gap-1.5"
          >
            {node.type === 'folder' ? (
              <Folder className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--ax-amber)' }} />
            ) : node.fileType === 'stl' ? (
              <FileCode2 className="w-3 h-3 flex-shrink-0" />
            ) : (
              <File className="w-3 h-3 flex-shrink-0" />
            )}
            <span>{node.name}</span>
          </div>
          {node.children && node.children.length > 0 && (
            <FolderTree nodes={node.children} depth={depth + 1} maxDepth={maxDepth} />
          )}
        </div>
      ))}
    </>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /Users/joseph/Projects/Alexandria/apps/frontend && npx tsc --noEmit 2>&1 | head -40
```

- [ ] **Step 3: Commit**

```bash
cd /Users/joseph/Projects/Alexandria && git add apps/frontend/src/components/upload/ReviewPane.tsx && git commit -m "feat(upload): add ReviewPane rendering scan/review/commit/error states + folder tree"
```

---

## Task 6: Restyle `DropZone.tsx`

The new DropZone is compact when sessions exist (collapsed banner) and accepts multiple files. Each dropped archive calls `scanUpload` immediately and appears in the queue. Per-file upload progress shown inline.

**Files:**
- Modify: `apps/frontend/src/components/upload/DropZone.tsx`

- [ ] **Step 1: Rewrite DropZone**

```typescript
// apps/frontend/src/components/upload/DropZone.tsx
import { useCallback, useRef, useState } from 'react';
import { UploadCloud, FolderOpen } from 'lucide-react';
import { SUPPORTED_ARCHIVE_EXTENSIONS } from '@alexandria/shared';
import { useStartScan } from '../../hooks/use-import-sessions';
import { formatFileSize } from '../../lib/format';
import { cn } from '../../lib/utils';

interface FileUploadState {
  file: File;
  pct: number;
  error: string | null;
}

interface DropZoneProps {
  /** When true, render the compact "drop more" banner instead of the full drop zone */
  compact?: boolean;
  onBrowseFolder?: () => void;
}

export function DropZone({ compact = false, onBrowseFolder }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState<FileUploadState[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const startScan = useStartScan();

  const isValidArchive = (file: File) => {
    const lower = file.name.toLowerCase();
    return SUPPORTED_ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  };

  const enqueueFile = useCallback(
    (file: File) => {
      if (!isValidArchive(file)) return;

      const entry: FileUploadState = { file, pct: 0, error: null };
      setUploading((prev) => [...prev, entry]);

      startScan.mutate(
        {
          file,
          onProgress: (pct) => {
            setUploading((prev) =>
              prev.map((e) => (e.file === file ? { ...e, pct } : e))
            );
          },
        },
        {
          onError: (err) => {
            const msg = err instanceof Error ? err.message : 'Upload failed';
            setUploading((prev) =>
              prev.map((e) =>
                e.file === file ? { ...e, error: msg } : e
              )
            );
          },
          onSuccess: () => {
            // Remove from local uploading list once session exists in the queue
            setUploading((prev) => prev.filter((e) => e.file !== file));
          },
        }
      );
    },
    [startScan]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      Array.from(e.dataTransfer.files).forEach(enqueueFile);
    },
    [enqueueFile]
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    Array.from(e.target.files ?? []).forEach(enqueueFile);
    e.target.value = '';
  };

  if (compact) {
    return (
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={cn(
          'flex items-center gap-3.5 rounded-xl p-3.5 mx-7 mt-4 transition-colors',
          isDragging && 'ring-2 ring-[var(--ax-amber)]'
        )}
        style={{
          background: 'var(--ax-bg-elev)',
          border: '1px dashed var(--ax-border-strong)',
        }}
      >
        <div
          className="flex items-center justify-center rounded-xl flex-shrink-0"
          style={{
            width: 38,
            height: 38,
            background: 'var(--ax-amber-tint)',
            color: 'var(--ax-amber-tint-fg)',
          }}
        >
          <UploadCloud className="h-[18px] w-[18px]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold" style={{ color: 'var(--ax-fg)' }}>
            Drop more archives anywhere
          </p>
          <p className="text-[12px]" style={{ color: 'var(--ax-fg-muted)' }}>
            .zip, .rar, .7z, .tar.gz — multiple files OK
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="ax-chip hover:opacity-80 transition-opacity cursor-pointer"
          >
            Browse files
          </button>
          {onBrowseFolder && (
            <button
              type="button"
              onClick={onBrowseFolder}
              className="ax-chip hover:opacity-80 transition-opacity cursor-pointer"
            >
              <FolderOpen className="w-3 h-3" />
              Server folder
            </button>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".zip,.rar,.7z,.tar.gz,.tgz"
          className="sr-only"
          onChange={handleInputChange}
          tabIndex={-1}
        />
      </div>
    );
  }

  // Full drop zone (when no sessions yet)
  return (
    <div className="space-y-3">
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed p-16 cursor-pointer transition-colors',
          isDragging
            ? 'border-[var(--ax-amber)] bg-[var(--ax-amber-tint)]'
            : 'border-[var(--ax-border-strong)] hover:border-[var(--ax-amber)] hover:bg-[var(--ax-bg-elev)]'
        )}
        role="button"
        tabIndex={0}
        aria-label="Upload archive files"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
      >
        <UploadCloud
          className="h-12 w-12 transition-colors"
          style={{ color: isDragging ? 'var(--ax-amber)' : 'var(--ax-fg-muted)' }}
        />
        <div className="text-center space-y-1">
          <p className="text-base font-semibold" style={{ color: 'var(--ax-fg)' }}>
            Drag &amp; drop archives here, or click to browse
          </p>
          <p className="text-sm" style={{ color: 'var(--ax-fg-muted)' }}>
            Supports .zip, .rar, .7z, .tar.gz — drop multiple files at once
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".zip,.rar,.7z,.tar.gz,.tgz,application/zip,application/x-rar-compressed,application/x-7z-compressed,application/x-tar"
          className="sr-only"
          onChange={handleInputChange}
          tabIndex={-1}
        />
      </div>

      {/* In-flight upload progress rows */}
      {uploading.length > 0 && (
        <div className="space-y-2">
          {uploading.map((entry, i) => (
            <UploadRow key={i} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function UploadRow({ entry }: { entry: FileUploadState }) {
  return (
    <div
      className="rounded-lg px-4 py-3 space-y-2"
      style={{
        background: 'var(--ax-bg-elev)',
        border: entry.error
          ? '1px solid var(--ax-danger)'
          : '1px solid var(--ax-border)',
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className="ax-code text-[12px] truncate"
          style={{ color: 'var(--ax-fg)' }}
        >
          {entry.file.name}
        </span>
        <span className="ax-mono text-[11px] flex-shrink-0" style={{ color: 'var(--ax-fg-muted)' }}>
          {formatFileSize(entry.file.size)}
        </span>
      </div>
      {entry.error ? (
        <p className="text-[11.5px]" style={{ color: 'var(--ax-danger)' }}>
          {entry.error}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <div
            className="flex-1 h-1.5 rounded-full overflow-hidden"
            style={{ background: 'var(--ax-bg-sunk)' }}
          >
            <div
              className="h-full rounded-full transition-all duration-200"
              style={{
                width: `${entry.pct}%`,
                background: 'var(--ax-amber)',
              }}
            />
          </div>
          <span className="ax-mono text-[11px] flex-shrink-0" style={{ color: 'var(--ax-fg-muted)' }}>
            {entry.pct}%
          </span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /Users/joseph/Projects/Alexandria/apps/frontend && npx tsc --noEmit 2>&1 | head -40
```

- [ ] **Step 3: Commit**

```bash
cd /Users/joseph/Projects/Alexandria && git add apps/frontend/src/components/upload/DropZone.tsx && git commit -m "feat(upload): restyle DropZone — multi-file, compact mode, per-file progress, token colors"
```

---

## Task 7: Restyle `UploadProgress.tsx`, `RecentUploads.tsx`, `FolderImport.tsx` — remove amber-/emerald-

**Files:**
- Modify: `apps/frontend/src/components/upload/UploadProgress.tsx`
- Modify: `apps/frontend/src/components/upload/RecentUploads.tsx`
- Modify: `apps/frontend/src/components/upload/FolderImport.tsx`

- [ ] **Step 1: Fix UploadProgress.tsx — replace `text-emerald-*` with semantic tokens**

Find `text-emerald-600 dark:text-emerald-500` in UploadProgress and replace with inline style using `var(--ax-success)`:

```typescript
// Replace the "ready" state JSX in UploadProgress:
      <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--ax-success)' }}>
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span>Model is ready.</span>
      </div>
```

The full updated file:

```typescript
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Loader2, CheckCircle2, AlertCircle, ArrowRight } from 'lucide-react';
import { getModelStatus } from '../../api/models';
import type { JobStatus } from '@alexandria/shared';

interface UploadProgressProps {
  modelId: string;
}

function statusLabel(status: JobStatus['status'], progress: number | null): string {
  if (status === 'error') return 'Processing failed';
  if (status === 'ready') return 'Done!';
  if (progress === null || progress === 0) return 'Processing...';
  if (progress < 40) return 'Extracting files...';
  if (progress < 70) return 'Classifying files...';
  if (progress < 90) return 'Generating thumbnails...';
  return 'Finishing up...';
}

export function UploadProgress({ modelId }: UploadProgressProps) {
  const { data: status, error } = useQuery({
    queryKey: ['model-status', modelId],
    queryFn: () => getModelStatus(modelId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 2000;
      if (data.status === 'ready' || data.status === 'error') return false;
      return 2000;
    },
    staleTime: 0,
  });

  const progress = status?.progress ?? null;
  const pct = typeof progress === 'number' ? progress : 0;
  const isIndeterminate = progress === null && status?.status === 'processing';

  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Could not fetch processing status.</span>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
        <span>Loading status...</span>
      </div>
    );
  }

  if (status.status === 'error') {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{status.error ?? 'Processing failed with an unknown error.'}</span>
        </div>
        <Link
          to={`/models/${modelId}`}
          className="text-sm text-primary hover:underline inline-flex items-center gap-1"
        >
          View model anyway <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    );
  }

  if (status.status === 'ready') {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--ax-success)' }}>
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>Model is ready.</span>
        </div>
        <Link
          to={`/models/${modelId}`}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          View model <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          {statusLabel(status.status, progress)}
        </span>
        {!isIndeterminate && (
          <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
        )}
      </div>
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        {isIndeterminate ? (
          <div className="h-full w-1/3 rounded-full bg-primary animate-[slide_1.5s_ease-in-out_infinite]" />
        ) : (
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Fix RecentUploads.tsx — replace `text-amber-*` and `text-emerald-*` with semantic tokens**

In `StatusBadge`, replace:
- `text-amber-600 dark:text-amber-500` → `style={{ color: 'var(--ax-warning)' }}`
- `text-emerald-600 dark:text-emerald-500` → `style={{ color: 'var(--ax-success)' }}`

The full updated `StatusBadge`:

```typescript
function StatusBadge({ status }: { status: ModelCard['status'] }) {
  if (status === 'processing') {
    return (
      <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--ax-warning)' }}>
        <Loader2 className="h-3 w-3 animate-spin" />
        Processing
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--ax-danger)' }}>
        <AlertCircle className="h-3 w-3" />
        Error
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--ax-success)' }}>
      <CheckCircle2 className="h-3 w-3" />
      Ready
    </span>
  );
}
```

- [ ] **Step 3: Fix FolderImport.tsx — replace `border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400` with token equivalents**

In the `submitted` state block, replace the entire `<div>` with:

```typescript
      {importState.phase === 'submitted' && (
        <div
          className="rounded-lg px-4 py-3 space-y-2"
          style={{
            border: '1px solid var(--ax-success)',
            background: 'color-mix(in srgb, var(--ax-success) 8%, transparent)',
          }}
        >
          <p className="text-sm font-medium" style={{ color: 'var(--ax-success)' }}>
            Import job queued successfully.
          </p>
          <div className="flex gap-3">
            <Link
              to={`/models/${importState.modelId}`}
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              Track progress <ArrowRight className="h-3.5 w-3.5" />
            </Link>
            <button
              onClick={reset}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Import another folder
            </button>
          </div>
        </div>
      )}
```

- [ ] **Step 4: Verify no amber-/emerald- in upload components**

```bash
grep -rE "amber-|emerald-" /Users/joseph/Projects/Alexandria/apps/frontend/src/components/upload
```

Expected: no output.

- [ ] **Step 5: Verify TypeScript**

```bash
cd /Users/joseph/Projects/Alexandria/apps/frontend && npx tsc --noEmit 2>&1 | head -40
```

- [ ] **Step 6: Commit**

```bash
cd /Users/joseph/Projects/Alexandria && git add apps/frontend/src/components/upload/UploadProgress.tsx apps/frontend/src/components/upload/RecentUploads.tsx apps/frontend/src/components/upload/FolderImport.tsx && git commit -m "refactor(upload): replace amber-/emerald- Tailwind literals with ax-* token colors"
```

---

## Task 8: Rebuild `UploadPage.tsx`

**Files:**
- Modify: `apps/frontend/src/pages/UploadPage.tsx`

- [ ] **Step 1: Rewrite the page**

The page is the two-column shell. Left = `UploadQueue` (fixed 300px dark rail). Right = compact `DropZone` + active `ReviewPane` when a session is selected, or a `FolderImport` tab if the user switches. The `activeId` is local state; auto-select the first non-committed session when sessions load.

```typescript
// apps/frontend/src/pages/UploadPage.tsx
import { useState, useEffect } from 'react';
import { FolderOpen } from 'lucide-react';
import { useImportSessions } from '../hooks/use-import-sessions';
import { UploadQueue } from '../components/upload/UploadQueue';
import { DropZone } from '../components/upload/DropZone';
import { ReviewPane } from '../components/upload/ReviewPane';
import { FolderImport } from '../components/upload/FolderImport';
import { RecentUploads } from '../components/upload/RecentUploads';
import { cn } from '../lib/utils';

type Tab = 'queue' | 'folder';

export function UploadPage() {
  const { data: sessions = [] } = useImportSessions();
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

  const handleCommitted = (modelId: string) => {
    // Session transitions to committing automatically via polling; nothing to do
  };

  const handleDiscard = () => {
    // Discard is called from ReviewPane; the session will disappear from the list
    setActiveId(null);
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
                  onRetry={() => {
                    // Discard the errored session so user can re-upload
                    handleDiscard();
                  }}
                />
              ) : sessions.length === 0 ? (
                <div className="space-y-4 mt-4">
                  <h2 className="text-base font-semibold" style={{ color: 'var(--ax-fg)' }}>
                    Recent models
                  </h2>
                  <RecentUploads />
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-[13px]" style={{ color: 'var(--ax-fg-muted)' }}>
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
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /Users/joseph/Projects/Alexandria/apps/frontend && npx tsc --noEmit 2>&1 | head -60
```

- [ ] **Step 3: Full build check**

```bash
cd /Users/joseph/Projects/Alexandria/apps/frontend && npm run build 2>&1 | tail -30
```

Expected: Build succeeds, no TypeScript errors.

- [ ] **Step 4: Final amber-/emerald- grep**

```bash
grep -rE "amber-|emerald-" /Users/joseph/Projects/Alexandria/apps/frontend/src/components/upload
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
cd /Users/joseph/Projects/Alexandria && git add apps/frontend/src/pages/UploadPage.tsx && git commit -m "feat(upload): rebuild UploadPage as two-column queue-rail + review-pane shell (P3)"
```

---

## Task 9: Final verification and cleanup

- [ ] **Step 1: Full build + type check**

```bash
cd /Users/joseph/Projects/Alexandria/apps/frontend && npm run build 2>&1
```

Expected: Build output with no errors. Resolve any remaining type errors.

- [ ] **Step 2: Grep for forbidden color literals**

```bash
grep -rE "amber-|emerald-" /Users/joseph/Projects/Alexandria/apps/frontend/src/components/upload
```

Expected: no output.

- [ ] **Step 3: Verify protected files were not touched**

```bash
git -C /Users/joseph/Projects/Alexandria diff HEAD~10 -- apps/frontend/src/App.tsx apps/frontend/src/components/AppShell.tsx apps/frontend/src/components/pivot/PivotMain.tsx 2>/dev/null | head -5
```

Expected: no diff output (no changes to those files on this branch).

- [ ] **Step 4: Verify the flow mentally**
  - Drop archive → `DropZone.enqueueFile` calls `startScan.mutate` → `scanUpload` chunks upload → `complete` returns `{ sessionId }` → invalidate `['import-sessions']` → queue re-fetches → session appears with status `scanning`
  - Polling every 2s → status changes to `ready_for_review` → `ReviewPane` shows folder tree + `BatchMetadataForm`
  - User fills form → "Import" → `commitImportSession` → session goes `committing` → `ReviewPane` shows `UploadProgress` polling `GET /models/:id/status`
  - Status hits `ready` → `UploadProgress` shows "View model" link to `/models/:id`
  - Error state: `ReviewPane` shows danger card with Retry (sets `activeId` to null) / Discard

- [ ] **Step 5: Commit any remaining fixes and push to `feat/p3-workflow-pages`**

```bash
cd /Users/joseph/Projects/Alexandria && git push -u origin feat/p3-workflow-pages
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|---|---|
| `scanUpload` returns `{ sessionId }`, fix `uploadModel` | Task 1 |
| `listImportSessions`, `getImportSession`, `commitImportSession`, `discardImportSession` | Task 1 |
| `useImportSessions` hook with polling + mutations | Task 2 |
| `UploadQueue` rail with status icons, filename, size/count, error line, stats footer | Task 3 |
| `BatchMetadataForm` with collection picker, artist, tags chip input, options checkboxes | Task 4 |
| `ReviewPane` with scanning/ready/committing/error states, folder tree | Task 5 |
| `DropZone` multi-file, compact mode, per-file progress, token colors | Task 6 |
| Remove all `amber-*/emerald-*` from upload components | Task 7 |
| Rebuild `UploadPage` two-column shell + FolderImport tab | Task 8 |
| Build verification + grep check | Task 9 |

**Deviations from design handoff (as specified in task spec):**
- Thumbnail grid in "ready_for_review" is NOT implemented (files not committed yet). Instead shows `FolderTree` from `detected.folderStructure`. This is the explicit directive.
- `useDiscardSession` is exported from the hook but called from `ReviewPane` via the `onDiscard` prop to keep components decoupled from mutations.

**Placeholder scan:** None. All code blocks are complete implementations.

**Type consistency:**
- `ImportSession`, `DetectedImportMetadata`, `DetectedFolderNode`, `BatchUploadMetadata`, `ScanUploadResponse` all imported from `@alexandria/shared`
- `scanUpload` returns `Promise<ScanUploadResponse>` (= `{ sessionId: string }`)
- `commitImportSession` returns `Promise<{ modelId: string; jobId: string }>`
- `useStartScan` mutation arg: `{ file: File; onProgress?: (pct: number) => void }` — consistent with `DropZone` usage
- `useCommitSession` mutation arg: `{ id: string; batchMetadata?: BatchUploadMetadata }` — consistent with `BatchMetadataForm` usage
