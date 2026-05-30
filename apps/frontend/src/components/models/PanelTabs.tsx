export interface PanelTab<T extends string> {
  value: T;
  label: string;
  Icon?: React.ComponentType<{ className?: string }>;
  count?: number;
}

interface PanelTabsProps<T extends string> {
  tabs: PanelTab<T>[];
  value: T;
  onChange: (value: T) => void;
}

/**
 * Full-width segmented tab control for the model detail panel.
 *
 * A self-contained, token-styled segmented control modeled on the pivot
 * workspace ViewSwitch: the active tab gets the accent fill, inactive tabs are
 * muted. Uses tablist/tab roles. Kept self-contained (not a card-top bar) so
 * each tab's content can keep its own card chrome without nesting.
 */
export function PanelTabs<T extends string>({
  tabs,
  value,
  onChange,
}: PanelTabsProps<T>) {
  return (
    <div
      role="tablist"
      aria-label="Model details"
      className="flex items-stretch rounded-lg overflow-hidden"
      style={{
        border: '1px solid var(--ax-border)',
        background: 'var(--ax-bg-elev)',
      }}
    >
      {tabs.map(({ value: tabValue, label, Icon, count }, i) => {
        const isActive = value === tabValue;
        return (
          <button
            key={tabValue}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tabValue)}
            className="flex flex-1 items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors"
            style={{
              color: isActive ? 'var(--ax-amber-fg, white)' : 'var(--ax-fg-muted)',
              background: isActive ? 'var(--ax-amber)' : 'transparent',
              borderRight:
                i < tabs.length - 1 ? '1px solid var(--ax-border)' : 'none',
              cursor: 'pointer',
            }}
          >
            {Icon && <Icon className="h-4 w-4 flex-shrink-0" aria-hidden />}
            <span className="truncate">{label}</span>
            {count !== undefined && (
              <span
                className="ml-0.5 rounded-full px-1.5 text-xs"
                style={{
                  background: isActive
                    ? 'rgba(255,255,255,0.25)'
                    : 'var(--ax-bg-sunk)',
                  color: isActive ? 'inherit' : 'var(--ax-fg-muted)',
                }}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
