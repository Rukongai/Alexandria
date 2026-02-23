import type {
  MetadataFieldDetail,
  MetadataFieldValue,
  CreateMetadataFieldRequest,
  UpdateMetadataFieldRequest,
  SetModelMetadataRequest,
} from '@alexandria/shared';
import { get, post, patch, del } from './client';

export async function getFields(): Promise<MetadataFieldDetail[]> {
  const response = await get<MetadataFieldDetail[]>('/metadata/fields');
  return response.data;
}

export async function createField(
  data: CreateMetadataFieldRequest
): Promise<MetadataFieldDetail> {
  const response = await post<MetadataFieldDetail>('/metadata/fields', data);
  return response.data;
}

export async function updateField(
  id: string,
  data: UpdateMetadataFieldRequest
): Promise<MetadataFieldDetail> {
  const response = await patch<MetadataFieldDetail>(`/metadata/fields/${id}`, data);
  return response.data;
}

export async function deleteField(id: string): Promise<void> {
  await del(`/metadata/fields/${id}`);
}

export async function getFieldValues(slug: string): Promise<MetadataFieldValue[]> {
  const response = await get<MetadataFieldValue[]>(`/metadata/fields/${slug}/values`);
  return response.data;
}

export async function setModelMetadata(
  modelId: string,
  data: SetModelMetadataRequest
): Promise<void> {
  await patch(`/models/${modelId}/metadata`, data);
}
