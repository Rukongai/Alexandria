import type { ApiResponse } from '@alexandria/shared';

const BASE_URL = '/api';

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
  init: RequestInit = {}
): Promise<ApiResponse<T>> {
  const url = `${BASE_URL}${path}`;

  const headers: Record<string, string> = { ...init.headers as Record<string, string> };
  // Only set Content-Type when a body is present — Fastify rejects
  // Content-Type: application/json on requests with no body.
  if (init.body !== undefined) {
    headers['Content-Type'] ??= 'application/json';
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

export async function get<T>(path: string): Promise<ApiResponse<T>> {
  return request<T>(path, { method: 'GET' });
}

export async function post<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
  return request<T>(path, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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
  onProgress?: (pct: number) => void
): Promise<ApiResponse<T>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE_URL}${path}`);
    xhr.withCredentials = true;

    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });
    }

    xhr.addEventListener('load', () => {
      try {
        const body: ApiResponse<T> = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body);
        } else {
          const firstError = body.errors?.[0];
          reject(
            new ApiRequestError(
              xhr.status,
              firstError?.code ?? 'UNKNOWN_ERROR',
              firstError?.message ?? `Upload failed with status ${xhr.status}`,
              firstError?.field ?? null
            )
          );
        }
      } catch {
        reject(new ApiRequestError(xhr.status, 'PARSE_ERROR', 'Failed to parse response'));
      }
    });

    xhr.addEventListener('error', () => {
      reject(new ApiRequestError(0, 'NETWORK_ERROR', 'Network request failed'));
    });

    xhr.send(formData);
  });
}

export async function putRaw<T>(
  path: string,
  data: Blob,
  onProgress?: (pct: number) => void
): Promise<ApiResponse<T>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${BASE_URL}${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });
    }

    xhr.addEventListener('load', () => {
      try {
        const body: ApiResponse<T> = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body);
        } else {
          const firstError = body.errors?.[0];
          reject(
            new ApiRequestError(
              xhr.status,
              firstError?.code ?? 'UNKNOWN_ERROR',
              firstError?.message ?? `Upload failed with status ${xhr.status}`,
              firstError?.field ?? null
            )
          );
        }
      } catch {
        reject(new ApiRequestError(xhr.status, 'PARSE_ERROR', 'Failed to parse response'));
      }
    });

    xhr.addEventListener('error', () => {
      reject(new ApiRequestError(0, 'NETWORK_ERROR', 'Network request failed'));
    });

    xhr.send(data);
  });
}
