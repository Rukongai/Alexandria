import type { GlobalSearchParams, GlobalSearchResult } from '@alexandria/shared';
import { get } from './client';
import { buildQueryString } from '../lib/query';

export async function globalSearch(params: GlobalSearchParams): Promise<GlobalSearchResult> {
  const qs = buildQueryString(params as unknown as Record<string, unknown>);
  const response = await get<GlobalSearchResult>(`/search${qs}`);
  return response.data;
}
