import type {
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
