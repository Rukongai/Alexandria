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

export async function ignoreDuplicates(): Promise<IgnoreDuplicatesResult> {
  const response = await post<IgnoreDuplicatesResult>('/tools/duplicates/ignore');
  return response.data;
}
