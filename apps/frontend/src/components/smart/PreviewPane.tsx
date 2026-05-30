import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, AlertCircle } from 'lucide-react';
import type { RuleNode } from '@alexandria/shared';
import { ModelCard } from '../models/ModelCard';
import { previewSmartCollection } from '../../api/smart-collections';
import { ApiRequestError } from '../../api/client';

/** Debounce a value so the preview doesn't refetch on every keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

interface Props {
  definition: RuleNode;
}

/** Live preview of the models a rule tree matches, used by the composer. */
export function PreviewPane({ definition }: Props) {
  const serialized = JSON.stringify(definition);
  const debounced = useDebounced(serialized, 400);

  const query = useQuery({
    queryKey: ['smart-preview', debounced],
    queryFn: () => previewSmartCollection({ definition: JSON.parse(debounced) as RuleNode }),
    staleTime: 10_000,
    retry: false,
  });

  const total = query.data?.meta?.total ?? 0;
  const models = query.data?.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Preview</h2>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {query.isFetching && <Loader2 className="h-3 w-3 animate-spin" />}
          {!query.isError && `${total} model${total === 1 ? '' : 's'}`}
        </span>
      </div>

      {query.isError ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            {query.error instanceof ApiRequestError
              ? query.error.message
              : 'Could not preview this rule.'}
          </span>
        </div>
      ) : models.length === 0 && !query.isFetching ? (
        <p className="text-sm text-muted-foreground">No models match these rules yet.</p>
      ) : (
        <div
          className="grid flex-1 content-start gap-3 overflow-y-auto"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
        >
          {models.map((model) => (
            <ModelCard key={model.id} model={model} />
          ))}
        </div>
      )}
    </div>
  );
}
