import type {
  ApiResponse,
  Library,
  CreateLibraryRequest,
  UpdateLibraryRequest,
} from '@alexandria/shared';
import { get, post, patch, del } from './client';

export async function getLibraries(): Promise<ApiResponse<Library[]>> {
  return get<Library[]>('/libraries');
}

export async function getLibrary(id: string): Promise<ApiResponse<Library>> {
  return get<Library>(`/libraries/${id}`);
}

export async function createLibrary(data: CreateLibraryRequest): Promise<Library> {
  const response = await post<Library>('/libraries', data);
  return response.data;
}

export async function updateLibrary(id: string, data: UpdateLibraryRequest): Promise<Library> {
  const response = await patch<Library>(`/libraries/${id}`, data);
  return response.data;
}

export async function deleteLibrary(id: string): Promise<void> {
  await del(`/libraries/${id}`);
}
