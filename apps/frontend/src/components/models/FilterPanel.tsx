import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, SlidersHorizontal } from 'lucide-react';
import type { MetadataFieldDetail, MetadataFieldValue } from '@alexandria/shared';
import { getFields, getFieldValues } from '../../api/metadata';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Skeleton } from '../ui/skeleton';
import { cn } from '../../lib/utils';

interface FilterPanelProps {
  activeTags: string[];
  metadataFilters: Record<string, string>;
  onToggleTag: (slug: string) => void;
  onSetMetaFilter: (slug: string, value: string | undefined) => void;
  className?: string;
}

// Individual field filter section
function FieldFilterSection({
  field,
  activeTags,
  metadataFilters,
  onToggleTag,
  onSetMetaFilter,
}: {
  field: MetadataFieldDetail;
  activeTags: string[];
  metadataFilters: Record<string, string>;
  onToggleTag: (slug: string) => void;
  onSetMetaFilter: (slug: string, value: string | undefined) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const isTagsField = field.slug === 'tags' && field.type === 'multi_enum';

  const { data: values, isLoading } = useQuery<MetadataFieldValue[]>({
    queryKey: ['field-values', field.slug],
    queryFn: () => getFieldValues(field.slug),
    enabled: field.type === 'multi_enum' || field.type === 'enum',
    staleTime: 60_000,
  });

  function renderFieldInput() {
    if (isLoading) {
      return (
        <div className="space-y-2 mt-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      );
    }

    if (field.type === 'multi_enum' || field.type === 'enum') {
      const items = values ?? [];
      if (items.length === 0) return null;

      return (
        <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto pr-1">
          {items.map((item) => {
            const isActive = isTagsField
              ? activeTags.includes(item.value)
              : metadataFilters[field.slug] === item.value;

            function handleChange() {
              if (isTagsField) {
                onToggleTag(item.value);
              } else {
                onSetMetaFilter(field.slug, isActive ? undefined : item.value);
              }
            }

            return (
              <label
                key={item.value}
                className="flex items-center justify-between gap-2 cursor-pointer group"
              >
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={handleChange}
                    className="h-4 w-4 rounded border border-input accent-primary cursor-pointer"
                  />
                  <span className="text-sm text-foreground group-hover:text-foreground/80 leading-none truncate">
                    {item.value}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground shrink-0">{item.modelCount}</span>
              </label>
            );
          })}
        </div>
      );
    }

    if (field.type === 'boolean') {
      const currentValue = metadataFilters[field.slug];
      return (
        <div className="mt-2 space-y-1.5">
          {['true', 'false'].map((val) => (
            <label key={val} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name={`meta-${field.slug}`}
                checked={currentValue === val}
                onChange={() => onSetMetaFilter(field.slug, currentValue === val ? undefined : val)}
                className="h-4 w-4 accent-primary cursor-pointer"
              />
              <span className="text-sm text-foreground leading-none capitalize">{val === 'true' ? 'Yes' : 'No'}</span>
            </label>
          ))}
        </div>
      );
    }

    // text / number / url / date — free text input
    const currentValue = metadataFilters[field.slug] ?? '';
    return (
      <div className="mt-2">
        <Input
          value={currentValue}
          onChange={(e) => onSetMetaFilter(field.slug, e.target.value || undefined)}
          placeholder={`Filter by ${field.name.toLowerCase()}...`}
          className="h-8 text-sm"
        />
      </div>
    );
  }

  const content = renderFieldInput();
  if (content === null) return null;

  return (
    <div className="border-b border-border/60 last:border-0 pb-3 last:pb-0">
      <button
        type="button"
        className="flex w-full items-center justify-between py-2 text-sm font-medium text-foreground hover:text-foreground/80"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span>{field.name}</span>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {expanded && content}
    </div>
  );
}

export function FilterPanel({
  activeTags,
  metadataFilters,
  onToggleTag,
  onSetMetaFilter,
  className,
}: FilterPanelProps) {
  const { data: fields, isLoading } = useQuery<MetadataFieldDetail[]>({
    queryKey: ['metadata-fields'],
    queryFn: getFields,
    staleTime: 60_000,
  });

  const filterableFields = fields?.filter((f) => f.isFilterable) ?? [];

  return (
    <aside className={cn('flex flex-col', className)}>
      <div className="flex items-center gap-2 pb-3 border-b border-border mb-3">
        <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Filters</h2>
      </div>

      {isLoading && (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ))}
        </div>
      )}

      {!isLoading && filterableFields.length === 0 && (
        <p className="text-xs text-muted-foreground">No filters available.</p>
      )}

      {!isLoading && filterableFields.length > 0 && (
        <div className="space-y-0">
          {filterableFields.map((field) => (
            <FieldFilterSection
              key={field.id}
              field={field}
              activeTags={activeTags}
              metadataFilters={metadataFilters}
              onToggleTag={onToggleTag}
              onSetMetaFilter={onSetMetaFilter}
            />
          ))}
        </div>
      )}
    </aside>
  );
}
