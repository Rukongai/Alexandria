import { ArrowDownAZ, ArrowUpAZ } from 'lucide-react';
import type { ModelSearchParams } from '@alexandria/shared';
import { Select } from '../ui/select';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';

type SortField = NonNullable<ModelSearchParams['sort']>;
type SortDir = NonNullable<ModelSearchParams['sortDir']>;

interface SortControlsProps {
  sort: SortField | undefined;
  sortDir: SortDir | undefined;
  onSortChange: (sort: SortField | undefined, sortDir: SortDir | undefined) => void;
  className?: string;
}

const SORT_OPTIONS: { label: string; value: SortField }[] = [
  { label: 'Date Added', value: 'createdAt' },
  { label: 'Name', value: 'name' },
  { label: 'Size', value: 'totalSizeBytes' },
];

export function SortControls({ sort, sortDir, onSortChange, className }: SortControlsProps) {
  const currentSort = sort ?? 'createdAt';
  const currentDir = sortDir ?? 'desc';

  function handleSortChange(e: React.ChangeEvent<HTMLSelectElement>) {
    onSortChange(e.target.value as SortField, currentDir);
  }

  function toggleDirection() {
    onSortChange(currentSort, currentDir === 'asc' ? 'desc' : 'asc');
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Select
        value={currentSort}
        onChange={handleSortChange}
        aria-label="Sort by"
        className="w-36"
      >
        {SORT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </Select>
      <Button
        variant="outline"
        size="icon"
        onClick={toggleDirection}
        aria-label={currentDir === 'asc' ? 'Sort descending' : 'Sort ascending'}
        title={currentDir === 'asc' ? 'Currently ascending — click for descending' : 'Currently descending — click for ascending'}
      >
        {currentDir === 'asc' ? (
          <ArrowUpAZ className="h-4 w-4" />
        ) : (
          <ArrowDownAZ className="h-4 w-4" />
        )}
      </Button>
    </div>
  );
}
