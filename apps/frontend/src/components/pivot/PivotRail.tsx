import { BookOpen, ChevronDown } from 'lucide-react';
import { useModelFilters } from '../../hooks/use-model-filters';
import { AxisPicker } from './AxisPicker';
import { AxisFacetBody } from './AxisFacetBody';
import { UserMenu } from './UserMenu';

/**
 * Full dark pivot rail. Replaces Sidebar in the pivot workspace (wired in F19).
 *
 * Structure (top → bottom):
 *   1. Library header — static name + DISABLED library-switcher stub (multi-library is P5)
 *   2. AxisPicker — 2-col grid letting the user pick Collections / Artists / Tags
 *   3. AxisFacetBody — scrollable list for the active axis (flex-1)
 *   4. UserMenu — pinned footer with avatar, identity, theme toggle, Settings, Log out
 */
export function PivotRail() {
  const { axis } = useModelFilters();

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
        <div className="flex items-center gap-2 px-1 mb-2.5">
          <BookOpen className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--ax-amber)' }} />
          <span
            className="font-semibold truncate"
            style={{ fontSize: '14px', letterSpacing: '-0.01em', color: 'var(--ax-rail-fg)' }}
          >
            Alexandria
          </span>
        </div>

        {/*
         * Library switcher — DISABLED stub for P5 multi-library support.
         * The button is intentionally non-interactive; aria-disabled communicates
         * this to assistive technology.
         */}
        <button
          type="button"
          aria-disabled="true"
          title="Library switching coming soon"
          className="flex items-center gap-2.5 w-full rounded-lg px-2.5 py-2 text-left cursor-not-allowed opacity-80"
          style={{
            background: 'var(--ax-rail-elev)',
            border: '1px solid var(--ax-rail-border)',
            color: 'inherit',
            fontFamily: 'inherit',
          }}
          tabIndex={-1}
        >
          {/* Library color badge */}
          <div
            className="flex-shrink-0 flex items-center justify-center rounded-lg font-bold"
            style={{
              width: 28,
              height: 28,
              background: 'linear-gradient(135deg, var(--ax-amber) 0%, var(--ax-amber-deep) 100%)',
              color: 'var(--ax-amber-fg)',
              fontSize: '11px',
            }}
          >
            L
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="font-semibold truncate"
              style={{ fontSize: '13px', color: 'var(--ax-rail-fg)' }}
            >
              Library
            </div>
            <div
              className="ax-mono truncate"
              style={{ fontSize: '11.5px', color: 'var(--ax-rail-fg-muted)' }}
            >
              active
            </div>
          </div>
          <ChevronDown
            className="flex-shrink-0 h-3 w-3"
            style={{ color: 'var(--ax-rail-fg-muted)' }}
          />
        </button>
      </div>

      {/* ── Axis picker ─────────────────────────────────────── */}
      <div className="flex-shrink-0">
        <AxisPicker />
      </div>

      {/* ── Scrollable facet body ────────────────────────────── */}
      <AxisFacetBody axis={axis} />

      {/* ── User menu (pinned footer) ────────────────────────── */}
      <UserMenu />
    </aside>
  );
}
