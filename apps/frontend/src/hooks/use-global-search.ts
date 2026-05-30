import { useQuery } from '@tanstack/react-query';
import type { GlobalSearchResult } from '@alexandria/shared';
import { globalSearch } from '../api/search';

export function useGlobalSearch(q: string, limit?: number) {
  return useQuery<GlobalSearchResult>({
    queryKey: ['search', q, limit],
    queryFn: () => globalSearch({ q, limit }),
    enabled: q.trim().length > 0,
    staleTime: 30_000,
  });
}
