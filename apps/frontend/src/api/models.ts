import type {
  ApiResponse,
  ModelCard,
  ModelDetail,
  FileTreeNode,
  JobStatus,
  ModelSearchParams,
  UpdateModelRequest,
  ImportConfig,
} from '@alexandria/shared';
import { get, post, patch, del, postForm } from './client';
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

export async function uploadModel(
  file: File,
  onProgress?: (pct: number) => void
): Promise<{ modelId: string }> {
  const formData = new FormData();
  formData.append('file', file);
  const response = await postForm<{ modelId: string }>('/models/upload', formData, onProgress);
  return response.data;
}

export async function importFolder(config: ImportConfig): Promise<{ modelId: string }> {
  const response = await post<{ modelId: string }>('/models/import', config);
  return response.data;
}
