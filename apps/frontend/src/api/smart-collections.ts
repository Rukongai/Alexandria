import type {
  ApiResponse,
  SmartCollection,
  SmartCollectionDetail,
  CreateSmartCollectionRequest,
  UpdateSmartCollectionRequest,
  PreviewSmartCollectionRequest,
  ModelCard,
  ModelSearchParams,
} from '@alexandria/shared';
import { get, post, patch, del } from './client';
import { buildQueryString } from '../lib/query';

export async function getSmartCollections(): Promise<ApiResponse<SmartCollection[]>> {
  return get<SmartCollection[]>('/smart-collections');
}

export async function getSmartCollection(id: string): Promise<SmartCollectionDetail> {
  const response = await get<SmartCollectionDetail>(`/smart-collections/${id}`);
  return response.data;
}

export async function getSmartCollectionModels(
  id: string,
  params?: ModelSearchParams
): Promise<ApiResponse<ModelCard[]>> {
  const qs = params ? buildQueryString(params as Record<string, unknown>) : '';
  return get<ModelCard[]>(`/smart-collections/${id}/models${qs}`);
}

export async function createSmartCollection(
  data: CreateSmartCollectionRequest
): Promise<SmartCollectionDetail> {
  const response = await post<SmartCollectionDetail>('/smart-collections', data);
  return response.data;
}

export async function updateSmartCollection(
  id: string,
  data: UpdateSmartCollectionRequest
): Promise<SmartCollectionDetail> {
  const response = await patch<SmartCollectionDetail>(`/smart-collections/${id}`, data);
  return response.data;
}

export async function deleteSmartCollection(id: string): Promise<void> {
  await del(`/smart-collections/${id}`);
}

/** Dry-run an unsaved rule tree for the composer's live preview. */
export async function previewSmartCollection(
  data: PreviewSmartCollectionRequest
): Promise<ApiResponse<ModelCard[]>> {
  return post<ModelCard[]>('/smart-collections/preview', data);
}
