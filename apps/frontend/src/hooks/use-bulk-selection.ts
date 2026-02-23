import { useState, useCallback } from 'react';

export interface BulkSelectionHook {
  selected: Set<string>;
  toggle: (id: string) => void;
  selectAll: (ids: string[]) => void;
  clear: () => void;
  isSelected: (id: string) => boolean;
  count: number;
}

export function useBulkSelection(): BulkSelectionHook {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback((ids: string[]) => {
    setSelected(new Set(ids));
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
  }, []);

  const isSelected = useCallback(
    (id: string) => selected.has(id),
    [selected]
  );

  return {
    selected,
    toggle,
    selectAll,
    clear,
    isSelected,
    count: selected.size,
  };
}
