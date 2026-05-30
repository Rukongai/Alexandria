import { BookOpen, ChevronDown } from 'lucide-react';
import type { GlobalSearchResult } from '@alexandria/shared';

type ResultTypeFilter = 'all' | 'models' | 'collections' | 'artists' | 'tags';

interface SearchRailProps {
  result: GlobalSearchResult | undefined;
  activeType: ResultTypeFilter;
  onTypeChange: (type: ResultTypeFilter) => void;
}

interface RailRowProps {
  label: string;
  count: number;
  active?: boolean;
  onClick?: () => void;
}

function RailRow({ label, count, active, onClick }: RailRowProps) {
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 6,
        cursor: onClick ? 'pointer' : 'default',
        background: active ? 'var(--ax-rail-active)' : 'transparent',
        color: active ? 'white' : 'var(--ax-rail-fg-muted)',
        fontSize: 12.5,
      }}
    >
      <span style={{ flex: 1 }}>{label}</span>
      <span className="ax-mono" style={{ fontSize: 11 }}>{count}</span>
    </div>
  );
}

function RailSectionHeader({ title }: { title: string }) {
  return (
    <div
      className="ax-mono"
      style={{
        padding: '8px 8px 4px',
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--ax-rail-fg-muted)',
        opacity: 0.6,
      }}
    >
      {title}
    </div>
  );
}

export function SearchRail({ result, activeType, onTypeChange }: SearchRailProps) {
  const totalModels = result?.models.total ?? 0;
  const totalCollections = result?.collections.length ?? 0;
  const totalArtists = result?.artists.length ?? 0;
  const totalTags = result?.tags.length ?? 0;
  const grandTotal = totalModels + totalCollections + totalArtists + totalTags;

  return (
    <aside
      style={{
        width: 220,
        background: 'var(--ax-rail)',
        color: 'var(--ax-rail-fg)',
        borderRight: '1px solid var(--ax-rail-border)',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Brand header */}
      <div
        style={{
          padding: '14px 16px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: '1px solid var(--ax-rail-border)',
        }}
      >
        <BookOpen size={16} style={{ color: 'var(--ax-amber)', flexShrink: 0 }} />
        <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--ax-rail-fg)' }}>
          Search
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 8px' }}>
        {/* Result type filter */}
        <RailSectionHeader title="Result type" />
        <div style={{ padding: '4px 0 14px' }}>
          <RailRow
            label="All results"
            count={grandTotal}
            active={activeType === 'all'}
            onClick={() => onTypeChange('all')}
          />
          <RailRow
            label="Models"
            count={totalModels}
            active={activeType === 'models'}
            onClick={() => onTypeChange('models')}
          />
          <RailRow
            label="Collections"
            count={totalCollections}
            active={activeType === 'collections'}
            onClick={() => onTypeChange('collections')}
          />
          <RailRow
            label="Artists"
            count={totalArtists}
            active={activeType === 'artists'}
            onClick={() => onTypeChange('artists')}
          />
          <RailRow
            label="Tags"
            count={totalTags}
            active={activeType === 'tags'}
            onClick={() => onTypeChange('tags')}
          />
        </div>

        {/* Library section — cosmetic, single library */}
        <RailSectionHeader title="Library" />
        <div style={{ padding: '4px 0 14px' }}>
          {/*
           * Multi-library switching is a later phase (P5).
           * Render a single cosmetic library entry that is non-interactive.
           */}
          <button
            type="button"
            aria-disabled="true"
            title="Library switching coming soon"
            tabIndex={-1}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '6px 8px',
              borderRadius: 6,
              background: 'var(--ax-rail-elev)',
              border: '1px solid var(--ax-rail-border)',
              color: 'var(--ax-rail-fg-muted)',
              fontFamily: 'inherit',
              fontSize: 12.5,
              cursor: 'not-allowed',
              opacity: 0.75,
            }}
          >
            <div
              style={{
                width: 20,
                height: 20,
                borderRadius: 5,
                background: 'linear-gradient(135deg, var(--ax-amber) 0%, var(--ax-amber-deep, #b45309) 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 10,
                fontWeight: 700,
                color: 'white',
                flexShrink: 0,
              }}
            >
              L
            </div>
            <span style={{ flex: 1, textAlign: 'left' }}>Library</span>
            <ChevronDown size={12} style={{ color: 'var(--ax-rail-fg-muted)' }} />
          </button>
        </div>

        {/* Visual-only filter toggles */}
        <RailSectionHeader title="Filter results" />
        <div style={{ padding: '4px 0 0' }}>
          <RailToggle label="Has 3D files" />
          <RailToggle label="Has images" />
          <RailToggle label="Pre-supported only" />
        </div>
      </div>
    </aside>
  );
}

function RailToggle({ label, active = false }: { label: string; active?: boolean }) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 6,
        cursor: 'default',
        fontSize: 12.5,
        color: 'var(--ax-rail-fg-muted)',
      }}
    >
      <span
        style={{
          width: 24,
          height: 14,
          borderRadius: 999,
          background: active ? 'var(--ax-amber)' : 'var(--ax-rail-elev)',
          border: `1px solid ${active ? 'var(--ax-amber)' : 'var(--ax-rail-border)'}`,
          position: 'relative',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 1,
            left: active ? 11 : 1,
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: 'white',
            transition: 'left .12s',
          }}
        />
      </span>
      <span>{label}</span>
    </label>
  );
}
