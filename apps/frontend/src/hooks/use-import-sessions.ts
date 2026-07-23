import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  BatchUploadMetadata,
  ImportSession,
  MultipartArchiveMode,
} from '@alexandria/shared';
import {
  listImportSessions,
  getImportSession,
  commitImportSession,
  discardImportSession,
  extractImportSessionArchive,
  uploadImportSessionFiles,
  scanUpload,
  scanMultipartUpload,
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
      signal,
      onFinalizing,
      currentLibraryId,
    }: {
      file: File;
      onProgress?: (pct: number) => void;
      signal?: AbortSignal;
      onFinalizing?: () => void;
      currentLibraryId: string | null;
    }) => scanUpload(file, onProgress, signal, onFinalizing, currentLibraryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['import-sessions'] });
    },
  });
}

/**
 * Upload an explicit archive group as one import session, then refresh the
 * review queue before resolving the mutation.
 */
export function useStartMultipartScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      files,
      mode,
      onProgress,
      signal,
      onFinalizing,
      currentLibraryId,
    }: {
      files: File[];
      mode: MultipartArchiveMode;
      onProgress?: (pct: number) => void;
      signal?: AbortSignal;
      onFinalizing?: () => void;
      currentLibraryId: string | null;
    }) => scanMultipartUpload(
      files,
      mode,
      onProgress,
      signal,
      onFinalizing,
      currentLibraryId,
    ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['import-sessions'] });
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

export function useExtractSessionArchive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, relativePath }: { id: string; relativePath: string }) =>
      extractImportSessionArchive(id, relativePath),
    onSuccess: (updatedSession, { id }) => {
      queryClient.setQueryData(['import-session', id], updatedSession);
      queryClient.setQueryData<ImportSession[]>(['import-sessions'], (sessions) =>
        sessions?.map((session) => session.id === id ? updatedSession : session),
      );
    },
  });
}

export function useAddSessionFiles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      files,
      onProgress,
    }: {
      id: string;
      files: File[];
      onProgress?: (pct: number) => void;
    }) => uploadImportSessionFiles(id, files, onProgress),
    onSuccess: (updatedSession, { id }) => {
      queryClient.setQueryData(['import-session', id], updatedSession);
      queryClient.setQueryData<ImportSession[]>(['import-sessions'], (sessions) =>
        sessions?.map((session) => session.id === id ? updatedSession : session),
      );
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
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['import-sessions'] });
      const previousSessions = queryClient.getQueryData<ImportSession[]>(['import-sessions']);
      queryClient.setQueryData<ImportSession[]>(['import-sessions'], (sessions) =>
        sessions?.filter((session) => session.id !== id),
      );
      return { previousSessions };
    },
    onError: (_error, _id, context) => {
      if (context?.previousSessions) {
        queryClient.setQueryData(['import-sessions'], context.previousSessions);
      }
    },
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: ['import-session', id] });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['import-sessions'] });
    },
  });
}
