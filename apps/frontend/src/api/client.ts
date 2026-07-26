import type { ApiResponse } from '@alexandria/shared';

const BASE_URL = '/api';

/**
 * The active library id, mirrored from the `/lib/:id` route by LibraryProvider.
 * Sent as the `X-Library-Id` header on every request so all resource endpoints
 * scope to the selected library without each api module threading it through.
 * Null on the All-Libraries home / login, where the backend falls back to the
 * user's default library.
 */
let activeLibraryId: string | null = null;

export function setActiveLibraryId(id: string | null): void {
  activeLibraryId = id;
}

const LIBRARY_HEADER = 'X-Library-Id';

export class ApiRequestError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public field: string | null = null
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  libraryIdOverride?: string | null,
): Promise<ApiResponse<T>> {
  const url = `${BASE_URL}${path}`;

  const headers: Record<string, string> = { ...init.headers as Record<string, string> };
  // Only set Content-Type when a body is present — Fastify rejects
  // Content-Type: application/json on requests with no body.
  if (init.body !== undefined) {
    headers['Content-Type'] ??= 'application/json';
  }
  if (libraryIdOverride !== undefined) {
    delete headers[LIBRARY_HEADER];
    if (libraryIdOverride) headers[LIBRARY_HEADER] = libraryIdOverride;
  } else if (activeLibraryId) {
    headers[LIBRARY_HEADER] ??= activeLibraryId;
  }

  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    headers,
  });

  const body: ApiResponse<T> = await response.json();

  if (!response.ok) {
    const firstError = body.errors?.[0];
    throw new ApiRequestError(
      response.status,
      firstError?.code ?? 'UNKNOWN_ERROR',
      firstError?.message ?? `Request failed with status ${response.status}`,
      firstError?.field ?? null
    );
  }

  return body;
}

export async function get<T>(path: string, signal?: AbortSignal): Promise<ApiResponse<T>> {
  return request<T>(path, { method: 'GET', signal });
}

/** Fetch a binary response while preserving the active library scope. */
export async function getBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (activeLibraryId) headers[LIBRARY_HEADER] = activeLibraryId;

  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    credentials: 'include',
    headers,
    signal,
  });

  if (!response.ok) {
    let body: ApiResponse<unknown> | null = null;
    try {
      body = await response.json() as ApiResponse<unknown>;
    } catch {
      // Keep the generic status error when a proxy did not return the API envelope.
    }
    const firstError = body?.errors?.[0];
    throw new ApiRequestError(
      response.status,
      firstError?.code ?? 'UNKNOWN_ERROR',
      firstError?.message ?? `Request failed with status ${response.status}`,
      firstError?.field ?? null,
    );
  }

  return response.blob();
}

export async function post<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  return request<T>(path, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
}

/**
 * POST against an explicitly captured library scope. Unlike `post`, this does
 * not consult the mutable active-library state when the request is sent.
 */
export async function postForLibrary<T>(
  path: string,
  body: unknown,
  libraryId: string | null,
): Promise<ApiResponse<T>> {
  return request<T>(path, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }, libraryId);
}

export async function patch<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
  return request<T>(path, {
    method: 'PATCH',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export async function del<T = null>(path: string): Promise<ApiResponse<T>> {
  return request<T>(path, { method: 'DELETE' });
}

export async function postForm<T>(
  path: string,
  formData: FormData,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;

    const cleanup = () => signal?.removeEventListener('abort', handleSignalAbort);
    const resolveOnce = (value: ApiResponse<T>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleSignalAbort = () => {
      xhr.abort();
      rejectOnce(new DOMException('Request aborted', 'AbortError'));
    };

    if (signal?.aborted) {
      rejectOnce(new DOMException('Request aborted', 'AbortError'));
      return;
    }

    xhr.open('POST', `${BASE_URL}${path}`);
    xhr.withCredentials = true;
    if (activeLibraryId) xhr.setRequestHeader(LIBRARY_HEADER, activeLibraryId);
    signal?.addEventListener('abort', handleSignalAbort, { once: true });

    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (!signal?.aborted && e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });
    }

    xhr.addEventListener('load', () => {
      try {
        const body: ApiResponse<T> = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolveOnce(body);
        } else {
          const firstError = body.errors?.[0];
          rejectOnce(
            new ApiRequestError(
              xhr.status,
              firstError?.code ?? 'UNKNOWN_ERROR',
              firstError?.message ?? `Upload failed with status ${xhr.status}`,
              firstError?.field ?? null
            )
          );
        }
      } catch {
        rejectOnce(new ApiRequestError(xhr.status, 'PARSE_ERROR', 'Failed to parse response'));
      }
    });

    xhr.addEventListener('error', () => {
      rejectOnce(new ApiRequestError(0, 'NETWORK_ERROR', 'Network request failed'));
    });
    xhr.addEventListener('abort', () => {
      rejectOnce(new DOMException('Request aborted', 'AbortError'));
    });

    xhr.send(formData);
  });
}

export async function putRaw<T>(
  path: string,
  data: Blob,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;

    const cleanup = () => signal?.removeEventListener('abort', handleSignalAbort);
    const resolveOnce = (value: ApiResponse<T>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleSignalAbort = () => {
      xhr.abort();
      rejectOnce(new DOMException('Request aborted', 'AbortError'));
    };

    if (signal?.aborted) {
      rejectOnce(new DOMException('Request aborted', 'AbortError'));
      return;
    }

    xhr.open('PUT', `${BASE_URL}${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (activeLibraryId) xhr.setRequestHeader(LIBRARY_HEADER, activeLibraryId);
    signal?.addEventListener('abort', handleSignalAbort, { once: true });

    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (!signal?.aborted && e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });
    }

    xhr.addEventListener('load', () => {
      try {
        const body: ApiResponse<T> = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolveOnce(body);
        } else {
          const firstError = body.errors?.[0];
          rejectOnce(
            new ApiRequestError(
              xhr.status,
              firstError?.code ?? 'UNKNOWN_ERROR',
              firstError?.message ?? `Upload failed with status ${xhr.status}`,
              firstError?.field ?? null
            )
          );
        }
      } catch {
        rejectOnce(new ApiRequestError(xhr.status, 'PARSE_ERROR', 'Failed to parse response'));
      }
    });

    xhr.addEventListener('error', () => {
      rejectOnce(new ApiRequestError(0, 'NETWORK_ERROR', 'Network request failed'));
    });
    xhr.addEventListener('abort', () => {
      rejectOnce(new DOMException('Request aborted', 'AbortError'));
    });

    xhr.send(data);
  });
}
