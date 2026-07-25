import type { DuplicateScanResult } from '@alexandria/shared';
import { get } from './client';

export async function scanDuplicates(): Promise<DuplicateScanResult> {
  const response = await get<DuplicateScanResult>('/tools/duplicates');
  return response.data;
}
