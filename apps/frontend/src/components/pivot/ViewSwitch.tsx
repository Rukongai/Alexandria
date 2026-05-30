import { useDisplayPreferences, type ViewMode } from '../../hooks/use-display-preferences';
import { GridViewIcon, ListViewIcon, GroupViewIcon } from '../icons';

const VIEWS: Array<{ mode: ViewMode; label: string; Icon: React.ComponentType<{ className?: string }> }> = [
  { mode: 'grid', label: 'Grid view', Icon: GridViewIcon },
  { mode: 'list', label: 'List view', Icon: ListViewIcon },
  { mode: 'group', label: 'Group view', Icon: GroupViewIcon },
];

/**
 * Segmented grid/list/group toggle.
 *
 * Reads and writes view state via useDisplayPreferences directly.
 * Active button is highlighted and marked aria-pressed=true.
 */
export function ViewSwitch() {
  const { view, setView } = useDisplayPreferences();

  return (
    <div
      className="flex items-center rounded-lg overflow-hidden"
      style={{
        border: '1px solid var(--ax-border)',
        background: 'var(--ax-bg-elev)',
      }}
      role="group"
      aria-label="View mode"
    >
      {VIEWS.map(({ mode, label, Icon }) => {
        const isActive = view === mode;
        return (
          <button
            key={mode}
            type="button"
            aria-pressed={isActive}
            aria-label={label}
            title={label}
            onClick={() => setView(mode)}
            className="flex items-center justify-center transition-colors"
            style={{
              width: 32,
              height: 32,
              background: isActive ? 'var(--ax-amber)' : 'transparent',
              color: isActive ? 'var(--ax-amber-fg, white)' : 'var(--ax-fg-muted)',
              border: 'none',
              cursor: 'pointer',
              borderRight: mode !== 'group' ? '1px solid var(--ax-border)' : 'none',
            }}
          >
            <Icon className="h-4 w-4" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
