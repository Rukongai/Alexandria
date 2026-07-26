import type {
  ConsolidateDuplicateModelsPreview,
  ConsolidateDuplicateModelsResult,
  DuplicateScanResult,
  IgnoreDuplicatesResult,
  MarkDuplicatesResult,
} from '@alexandria/shared';
import { get, post } from './client';

export async function scanDuplicates(): Promise<DuplicateScanResult> {
  const response = await get<DuplicateScanResult>('/tools/duplicates');
  return response.data;
}

export async function markDuplicates(): Promise<MarkDuplicatesResult> {
  const response = await post<MarkDuplicatesResult>('/tools/duplicates/mark');
  return response.data;
}

export async function markDuplicateFileGroup(hash: string): Promise<MarkDuplicatesResult> {
  const response = await post<MarkDuplicatesResult>(
    `/tools/duplicates/file-groups/${encodeURIComponent(hash)}/mark`,
  );
  return response.data;
}

export async function ignoreDuplicateFileGroup(hash: string): Promise<IgnoreDuplicatesResult> {
  const response = await post<IgnoreDuplicatesResult>(
    `/tools/duplicates/file-groups/${encodeURIComponent(hash)}/ignore`,
  );
  return response.data;
}

export async function previewDuplicateModelConsolidation(
  sourceModelId: string,
  targetModelId: string,
): Promise<ConsolidateDuplicateModelsPreview> {
  const response = await post<ConsolidateDuplicateModelsPreview>('/tools/duplicates/consolidate/preview', {
    sourceModelId,
    targetModelId,
  });
  return response.data;
}

export async function consolidateDuplicateModels(
  sourceModelId: string,
  targetModelId: string,
): Promise<ConsolidateDuplicateModelsResult> {
  const response = await post<ConsolidateDuplicateModelsResult>('/tools/duplicates/consolidate', {
    sourceModelId,
    targetModelId,
  });
  return response.data;
}
