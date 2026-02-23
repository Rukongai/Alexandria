import { X } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

interface ActiveFiltersProps {
  q: string;
  tags: string[];
  metadataFilters: Record<string, string>;
  onClearQ: () => void;
  onRemoveTag: (slug: string) => void;
  onClearMetaFilter: (slug: string) => void;
  onClearAll: () => void;
}

export function ActiveFilters({
  q,
  tags,
  metadataFilters,
  onClearQ,
  onRemoveTag,
  onClearMetaFilter,
  onClearAll,
}: ActiveFiltersProps) {
  const metaEntries = Object.entries(metadataFilters);
  const hasAny = q.length > 0 || tags.length > 0 || metaEntries.length > 0;

  if (!hasAny) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 py-2">
      {q && (
        <FilterChip label={`Search: "${q}"`} onRemove={onClearQ} />
      )}
      {tags.map((tag) => (
        <FilterChip key={tag} label={tag} onRemove={() => onRemoveTag(tag)} />
      ))}
      {metaEntries.map(([slug, value]) => (
        <FilterChip key={slug} label={`${slug}: ${value}`} onRemove={() => onClearMetaFilter(slug)} />
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={onClearAll}
      >
        Clear all
      </Button>
    </div>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Badge variant="secondary" className="flex items-center gap-1 pr-1">
      <span className="text-xs">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 rounded hover:bg-foreground/10 p-0.5"
        aria-label={`Remove filter: ${label}`}
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  );
}
