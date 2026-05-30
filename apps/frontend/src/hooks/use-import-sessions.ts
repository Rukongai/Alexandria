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
