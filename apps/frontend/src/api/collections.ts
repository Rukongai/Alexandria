import type {
  ApiResponse,
  CollectionDetail,
  CollectionListParams,
  CreateCollectionRequest,
  UpdateCollectionRequest,
  ModelCard,
  ModelSearchParams,
} from '@alexandria/shared';
import { get, post, patch, del } from './client';

function buildQueryString(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== ''
  );
  if (entries.length === 0) return '';
  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `?${qs}`;
}

export async function getCollections(
  params?: CollectionListParams
): Promise<ApiResponse<CollectionDetail[]>> {
  const qs = params ? buildQueryString(params as Record<string, unknown>) : '';
  return get<CollectionDetail[]>(`/collections${qs}`);
}

export async function getCollection(id: string): Promise<CollectionDetail> {
  const response = await get<CollectionDetail>(`/collections/${id}`);
  return response.data;
}

export async function getCollectionModels(
  id: string,
  params?: ModelSearchParams
): Promise<ApiResponse<ModelCard[]>> {
  const qs = params ? buildQueryString(params as Record<string, unknown>) : '';
  return get<ModelCard[]>(`/collections/${id}/models${qs}`);
}

export async function createCollection(
  data: CreateCollectionRequest
): Promise<CollectionDetail> {
  const response = await post<CollectionDetail>('/collections', data);
  return response.data;
}

export async function updateCollection(
  id: string,
  data: UpdateCollectionRequest
): Promise<CollectionDetail> {
  const response = await patch<CollectionDetail>(`/collections/${id}`, data);
  return response.data;
}

export async function deleteCollection(id: string): Promise<void> {
  await del(`/collections/${id}`);
}

export async function addModelsToCollection(
  id: string,
  modelIds: string[]
): Promise<void> {
  await post(`/collections/${id}/models`, { modelIds });
}

export async function removeModelFromCollection(
  collectionId: string,
  modelId: string
): Promise<void> {
  await del(`/collections/${collectionId}/models/${modelId}`);
}
