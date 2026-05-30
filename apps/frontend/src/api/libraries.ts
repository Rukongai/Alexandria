import type {
  ApiResponse,
  LibrarySummary,
  CreateLibraryRequest,
  UpdateLibraryRequest,
} from '@alexandria/shared';
import { get, post, patch, del } from './client';

export async function listLibraries(): Promise<ApiResponse<LibrarySummary[]>> {
  return get<LibrarySummary[]>('/libraries');
}

export async function createLibrary(data: CreateLibraryRequest): Promise<LibrarySummary> {
  const response = await post<LibrarySummary>('/libraries', data);
  return response.data;
}

export async function updateLibrary(
  id: string,
  data: UpdateLibraryRequest
): Promise<LibrarySummary> {
  const response = await patch<LibrarySummary>(`/libraries/${id}`, data);
  return response.data;
}

export async function setDefaultLibrary(id: string): Promise<void> {
  await post(`/libraries/${id}/set-default`);
}

export async function deleteLibrary(id: string): Promise<void> {
  await del(`/libraries/${id}`);
}
