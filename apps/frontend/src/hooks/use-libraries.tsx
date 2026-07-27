import React, { createContext, useContext, useEffect, useRef } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  LibrarySummary,
  CreateLibraryRequest,
  UpdateLibraryRequest,
} from '@alexandria/shared';
import * as librariesApi from '../api/libraries';
import { setActiveLibraryId } from '../api/client';
import { useAuth } from './use-auth';

interface LibrariesContextValue {
  libraries: LibrarySummary[];
  isLoading: boolean;
  /** The library id from the `/lib/:id` route (null on the home/login routes). */
  currentLibraryId: string | null;
  /** The resolved library object, once the list has loaded. */
  currentLibrary: LibrarySummary | null;
  createLibrary: (data: CreateLibraryRequest) => Promise<LibrarySummary>;
  updateLibrary: (id: string, data: UpdateLibraryRequest) => Promise<LibrarySummary>;
  setDefaultLibrary: (id: string) => Promise<void>;
  deleteLibrary: (id: string) => Promise<void>;
}

const LibrariesContext = createContext<LibrariesContextValue | null>(null);

export function LibraryProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // The `/lib/:libraryId` segment is the single source of truth for the active
  // library, at any depth (`/lib/:id`, `/lib/:id/models/:mid`, …).
  const match = useMatch('/lib/:libraryId/*');
  const currentLibraryId = match?.params.libraryId ?? null;

  // Mirror the route into the API client BEFORE children render so their data
  // fetches carry the X-Library-Id header on the very first request. Children's
  // effects run before a parent effect, so this must happen during render — not
  // in a useEffect — to avoid the first query racing ahead without the header.
  setActiveLibraryId(currentLibraryId);

  const { data: libraries = [], isLoading } = useQuery({
    queryKey: ['libraries'],
    queryFn: () => librariesApi.listLibraries().then((r) => r.data),
    enabled: isAuthenticated,
  });

  const currentLibrary = libraries.find((l) => l.id === currentLibraryId) ?? null;

  // Library-scoped query keys (models, collections, search, …) do NOT include the
  // library id — scoping rides on the X-Library-Id header instead. So when the
  // active library changes we must drop their cached entries, otherwise the
  // still-mounted workspace would show the previous library's data until refetch.
  // The 'libraries' query itself is preserved (it's user-scoped, not per-library).
  const prevLibraryId = useRef(currentLibraryId);
  useEffect(() => {
    if (prevLibraryId.current !== currentLibraryId) {
      prevLibraryId.current = currentLibraryId;
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'libraries' });
    }
  }, [currentLibraryId, queryClient]);

  // A `/lib/:id` deep link to an unknown or un-owned library bounces home once
  // the list has loaded (the backend would 404 every scoped request anyway).
  useEffect(() => {
    if (!isLoading && currentLibraryId && !currentLibrary) {
      navigate('/', { replace: true });
    }
  }, [isLoading, currentLibraryId, currentLibrary, navigate]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['libraries'] });

  const createMutation = useMutation({
    mutationFn: (data: CreateLibraryRequest) => librariesApi.createLibrary(data),
    onSuccess: invalidate,
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateLibraryRequest }) =>
      librariesApi.updateLibrary(id, data),
    onSuccess: invalidate,
  });
  const setDefaultMutation = useMutation({
    mutationFn: (id: string) => librariesApi.setDefaultLibrary(id),
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => librariesApi.deleteLibrary(id),
    onSuccess: invalidate,
  });

  return (
    <LibrariesContext.Provider
      value={{
        libraries,
        isLoading,
        currentLibraryId,
        currentLibrary,
        createLibrary: (data) => createMutation.mutateAsync(data),
        updateLibrary: (id, data) => updateMutation.mutateAsync({ id, data }),
        setDefaultLibrary: (id) => setDefaultMutation.mutateAsync(id),
        deleteLibrary: (id) => deleteMutation.mutateAsync(id),
      }}
    >
      {children}
    </LibrariesContext.Provider>
  );
}

export function useLibraries(): LibrariesContextValue {
  const context = useContext(LibrariesContext);
  if (!context) {
    throw new Error('useLibraries must be used within a LibraryProvider');
  }
  return context;
}

/**
 * Read library context when available without requiring a provider. This is
 * useful for pages that have isolated tests or can render outside the library
 * workspace; those callers simply hide library-specific actions.
 */
export function useLibrariesOptional(): LibrariesContextValue | null {
  return useContext(LibrariesContext);
}

/**
 * Returns the route-scoped library id without requiring a provider in isolated
 * component tests. Components that retain local library-scoped state use this
 * to guard that state across route transitions.
 */
export function useCurrentLibraryId(): string | null {
  return useContext(LibrariesContext)?.currentLibraryId ?? null;
}

/**
 * Returns a `libPath` function that prefixes an app path with the active
 * `/lib/:id` segment, so internal links stay scoped to the current library.
 * Falls back to the bare path when no library is active (the home page) or when
 * used outside a LibraryProvider (e.g. isolated component tests) — it reads the
 * context directly rather than through useLibraries so it never throws.
 */
export function useLibraryPath(): (path: string) => string {
  const ctx = useContext(LibrariesContext);
  const currentLibraryId = ctx?.currentLibraryId ?? null;
  return (path: string) => {
    if (!currentLibraryId) return path;
    const suffix = path === '/' ? '' : path;
    return `/lib/${currentLibraryId}${suffix}`;
  };
}
