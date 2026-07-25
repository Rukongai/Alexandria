import { useState } from 'react';
import { BookOpen, ChevronDown, Check, Plus, LayoutGrid } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useModelFilters } from '../../hooks/use-model-filters';
import { useLibraries } from '../../hooks/use-libraries';
import { libraryGradient, libraryInitials } from '../../lib/library-color';
import { LibraryDialog } from '../libraries/LibraryDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { AxisPicker } from './AxisPicker';
import { AxisFacetBody } from './AxisFacetBody';
import { UserMenu } from './UserMenu';

/**
 * Full dark pivot rail. Replaces Sidebar in the pivot workspace (wired in F19).
 *
 * Structure (top → bottom):
 *   1. Library header — brand + interactive library switcher (P5 multi-library)
 *   2. AxisPicker — 2-col grid letting the user pick Collections / Artists / Tags
 *   3. AxisFacetBody — scrollable list for the active axis (flex-1)
 *   4. UserMenu — pinned footer with avatar, identity, theme toggle, Tools, Settings, Log out
 */
export function PivotRail() {
  const { axis } = useModelFilters();
  const navigate = useNavigate();
  const { libraries, currentLibrary } = useLibraries();
  const [createOpen, setCreateOpen] = useState(false);

  const grad = libraryGradient(currentLibrary?.color ?? 'amber');

  return (
    <aside
      style={{
        width: 272,
        background: 'var(--ax-rail)',
        color: 'var(--ax-rail-fg)',
        borderRight: '1px solid var(--ax-rail-border)',
        flexShrink: 0,
      }}
      className="flex flex-col h-screen"
    >
      {/* ── Library header ──────────────────────────────────── */}
      <div
        className="flex-shrink-0 px-3 pt-3.5 pb-2.5"
        style={{ borderBottom: '1px solid var(--ax-rail-border)' }}
      >
        {/* Brand row */}
        <Link
          to="/"
          aria-label="Go to library"
          className="flex items-center gap-2 rounded-md px-1 mb-2.5 transition-colors hover:bg-[var(--ax-rail-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ax-rail-active)]"
        >
          <BookOpen className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--ax-amber)' }} />
          <span
            className="font-semibold truncate"
            style={{ fontSize: '14px', letterSpacing: '-0.01em', color: 'var(--ax-rail-fg)' }}
          >
            Alexandria
          </span>
        </Link>

        {/* Library switcher */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="Switch library"
              className="flex items-center gap-2.5 w-full rounded-lg px-2.5 py-2 text-left transition hover:brightness-110"
              style={{
                background: 'var(--ax-rail-elev)',
                border: '1px solid var(--ax-rail-border)',
                color: 'inherit',
                fontFamily: 'inherit',
              }}
            >
              {/* Library color badge */}
              <div
                className="flex-shrink-0 flex items-center justify-center rounded-lg font-bold"
                style={{
                  width: 28,
                  height: 28,
                  background: grad.background,
                  color: grad.color,
                  fontSize: '11px',
                }}
              >
                {currentLibrary ? libraryInitials(currentLibrary.name) : 'L'}
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className="font-semibold truncate"
                  style={{ fontSize: '13px', color: 'var(--ax-rail-fg)' }}
                >
                  {currentLibrary?.name ?? 'Library'}
                </div>
                <div
                  className="ax-mono truncate"
                  style={{ fontSize: '11.5px', color: 'var(--ax-rail-fg-muted)' }}
                >
                  {currentLibrary
                    ? `${currentLibrary.modelCount} ${currentLibrary.modelCount === 1 ? 'model' : 'models'}`
                    : 'active'}
                </div>
              </div>
              <ChevronDown
                className="flex-shrink-0 h-3 w-3"
                style={{ color: 'var(--ax-rail-fg-muted)' }}
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            {libraries.map((lib) => {
              const g = libraryGradient(lib.color);
              const active = lib.id === currentLibrary?.id;
              return (
                <DropdownMenuItem key={lib.id} onClick={() => navigate(`/lib/${lib.id}`)}>
                  <div
                    className="mr-2 flex-shrink-0 flex items-center justify-center rounded font-bold"
                    style={{ width: 20, height: 20, background: g.background, color: g.color, fontSize: '9px' }}
                  >
                    {libraryInitials(lib.name)}
                  </div>
                  <span className="flex-1 truncate">{lib.name}</span>
                  {active && <Check className="ml-2 h-4 w-4 flex-shrink-0" />}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate('/')}>
              <LayoutGrid className="mr-2 h-4 w-4" />
              All libraries
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New library…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* ── Axis picker ─────────────────────────────────────── */}
      <div className="flex-shrink-0">
        <AxisPicker />
      </div>

      {/* ── Scrollable facet body ────────────────────────────── */}
      <AxisFacetBody axis={axis} />

      {/* ── User menu (pinned footer) ────────────────────────── */}
      <UserMenu />

      <LibraryDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={(lib) => navigate(`/lib/${lib.id}`)}
      />
    </aside>
  );
}
