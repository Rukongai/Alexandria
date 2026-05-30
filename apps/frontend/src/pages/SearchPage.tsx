import { useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Search, Zap, Box, Folder, User, Hash, SortAsc } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import { useGlobalSearch } from '../hooks/use-global-search';
import { ModelCard } from '../components/models/ModelCard';
import { SearchSection } from '../components/search/SearchSection';
import { CollectionResultRow } from '../components/search/CollectionResultRow';
import { ArtistResultCard } from '../components/search/ArtistResultCard';
import { TagResultPill } from '../components/search/TagResultPill';
import { SearchRail } from '../components/search/SearchRail';

type ResultTypeFilter = 'all' | 'models' | 'collections' | 'artists' | 'tags';

const SEARCH_LIMIT = 6;

// A small inline tooltip for the disabled pill
function DisabledPill({ icon, label, tooltip }: { icon: React.ReactNode; label: string; tooltip: string }) {
  const [showTip, setShowTip] = useState(false);

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        aria-disabled="true"
        title={tooltip}
        onMouseEnter={() => setShowTip(true)}
        onMouseLeave={() => setShowTip(false)}
        onFocus={() => setShowTip(true)}
        onBlur={() => setShowTip(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 12px',
          borderRadius: 999,
          background: 'var(--ax-bg-elev)',
          border: '1px solid var(--ax-border)',
          color: 'var(--ax-fg-muted)',
          fontSize: 12,
          fontWeight: 500,
          cursor: 'not-allowed',
          opacity: 0.6,
          fontFamily: 'inherit',
        }}
      >
        {icon}
        {label}
      </button>
      {showTip && (
        <div
          role="tooltip"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: '50%',
            transform: 'translateX(-50%)',
            whiteSpace: 'nowrap',
            background: 'var(--ax-bg-sunk)',
            border: '1px solid var(--ax-border)',
            borderRadius: 6,
            padding: '5px 10px',
            fontSize: 11.5,
            color: 'var(--ax-fg)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            zIndex: 100,
            pointerEvents: 'none',
          }}
        >
          {tooltip}
        </div>
      )}
    </div>
  );
}

function ResultPill({ count, label, icon }: { count: number; label: string; icon: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 8px',
        borderRadius: 5,
        background: 'var(--ax-bg-sunk)',
        color: 'var(--ax-fg-muted)',
        fontSize: 11.5,
      }}
    >
      {icon}
      <span className="ax-mono" style={{ fontWeight: 600, color: 'var(--ax-fg)' }}>
        {count}
      </span>{' '}
      {label}
    </span>
  );
}

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const q = searchParams.get('q') ?? '';
  const refineRef = useRef<HTMLInputElement>(null);
  const [refineValue, setRefineValue] = useState('');
  const [activeType, setActiveType] = useState<ResultTypeFilter>('all');

  const { data, isLoading, isError } = useGlobalSearch(q, SEARCH_LIMIT);

  function handleRefineSubmit(e: React.FormEvent) {
    e.preventDefault();
    const val = refineValue.trim();
    if (!val) return;
    setSearchParams({ q: val });
    setRefineValue('');
    setActiveType('all');
  }

  const totalModels = data?.models.total ?? 0;
  const totalCollections = data?.collections.length ?? 0;
  const totalArtists = data?.artists.length ?? 0;
  const totalTags = data?.tags.length ?? 0;
  const grandTotal = totalModels + totalCollections + totalArtists + totalTags;

  const showModels = activeType === 'all' || activeType === 'models';
  const showCollections = activeType === 'all' || activeType === 'collections';
  const showArtists = activeType === 'all' || activeType === 'artists';
  const showTags = activeType === 'all' || activeType === 'tags';

  return (
    <div
      className="flex h-full min-h-0"
      style={{ background: 'var(--ax-bg)', color: 'var(--ax-fg)' }}
    >
      {/* Left search rail */}
      <SearchRail result={data} activeType={activeType} onTypeChange={setActiveType} />

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0 h-full">
        {/* ── Top bar ─────────────────────────────────────────────────── */}
        <div
          className="flex-shrink-0 flex items-center gap-3 px-6 py-2.5"
          style={{
            borderBottom: '1px solid var(--ax-border)',
            background: 'var(--ax-bg)',
          }}
        >
          {/* Left: search context indicator */}
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            <Search size={16} style={{ color: 'var(--ax-fg-muted)', flexShrink: 0 }} />
            <span style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' }}>
              Search:{' '}
              {q && (
                <span
                  style={{
                    color: 'var(--ax-amber-tint-fg)',
                    background: 'var(--ax-amber-tint)',
                    padding: '2px 8px',
                    borderRadius: 5,
                  }}
                >
                  {q}
                </span>
              )}
            </span>
          </div>

          {/* Center: refine search input */}
          <form onSubmit={handleRefineSubmit} className="flex-shrink-0">
            <label className="relative flex items-center">
              <span className="sr-only">Refine search</span>
              <Search
                size={13}
                className="absolute left-2.5 pointer-events-none"
                style={{ color: 'var(--ax-fg-muted)' }}
                aria-hidden
              />
              <input
                ref={refineRef}
                type="search"
                placeholder="Refine search…"
                value={refineValue}
                onChange={(e) => setRefineValue(e.target.value)}
                className="h-8 rounded-lg pl-8 pr-3 text-sm outline-none"
                style={{
                  width: 260,
                  background: 'var(--ax-bg-elev)',
                  border: '1px solid var(--ax-border)',
                  color: 'var(--ax-fg)',
                  fontFamily: 'inherit',
                }}
                aria-label="Refine search"
              />
            </label>
          </form>

          {/* Right: Save as Smart Collection (disabled) */}
          <div className="flex-shrink-0">
            <DisabledPill
              icon={<Zap size={12} />}
              label="Save as Smart Collection"
              tooltip="Available in a later update"
            />
          </div>
        </div>

        {/* ── Results summary bar ──────────────────────────────────────── */}
        {q && (
          <div
            className="flex-shrink-0 flex items-center gap-4 px-6 py-2.5"
            style={{
              borderBottom: '1px solid var(--ax-border)',
              fontSize: 12.5,
              color: 'var(--ax-fg-muted)',
            }}
          >
            {isLoading ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Loader2 size={13} className="animate-spin" />
                Searching…
              </span>
            ) : (
              <>
                <span className="ax-mono" style={{ color: 'var(--ax-fg)', fontWeight: 600 }}>
                  {grandTotal.toLocaleString()} results
                </span>
                <span>across</span>
                <ResultPill count={totalModels} label="models" icon={<Box size={11} />} />
                <ResultPill count={totalCollections} label="collections" icon={<Folder size={11} />} />
                <ResultPill count={totalArtists} label="artists" icon={<User size={11} />} />
                <ResultPill count={totalTags} label="tags" icon={<Hash size={11} />} />
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>Sort:</span>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '3px 8px',
                      borderRadius: 5,
                      background: 'var(--ax-bg-sunk)',
                      fontSize: 11.5,
                    }}
                  >
                    <SortAsc size={12} />
                    Best match
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Scrollable results ───────────────────────────────────────── */}
        <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: '8px 28px 28px' }}>
          {/* No query state */}
          {!q && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 300,
                gap: 12,
                textAlign: 'center',
                color: 'var(--ax-fg-muted)',
              }}
            >
              <Search size={40} style={{ opacity: 0.25 }} />
              <p style={{ fontSize: 15, fontWeight: 500, color: 'var(--ax-fg)' }}>
                Search your library
              </p>
              <p style={{ fontSize: 13, maxWidth: 320 }}>
                Use the search bar above, or press{' '}
                <kbd
                  style={{
                    display: 'inline-block',
                    padding: '1px 5px',
                    borderRadius: 4,
                    background: 'var(--ax-bg-sunk)',
                    border: '1px solid var(--ax-border)',
                    fontFamily: 'inherit',
                    fontSize: 11,
                  }}
                >
                  ⌘K
                </kbd>{' '}
                to open the command palette
              </p>
            </div>
          )}

          {/* Error state */}
          {q && isError && (
            <div
              style={{
                marginTop: 24,
                padding: '16px',
                borderRadius: 10,
                border: '1px solid var(--ax-danger, #ef4444)',
                background: 'color-mix(in srgb, var(--ax-danger, #ef4444) 10%, transparent)',
                color: 'var(--ax-danger, #ef4444)',
                fontSize: 13,
              }}
            >
              Search failed. Please try again.
            </div>
          )}

          {/* Zero results */}
          {q && !isLoading && !isError && grandTotal === 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 260,
                gap: 12,
                textAlign: 'center',
                color: 'var(--ax-fg-muted)',
              }}
            >
              <Search size={36} style={{ opacity: 0.2 }} />
              <p style={{ fontSize: 15, fontWeight: 500, color: 'var(--ax-fg)' }}>
                No results for "{q}"
              </p>
              <p style={{ fontSize: 13 }}>
                Try a different query, or check your spelling.
              </p>
            </div>
          )}

          {/* Results sections */}
          {q && !isLoading && data && grandTotal > 0 && (
            <>
              {/* Models */}
              {showModels && data.models.items.length > 0 && (
                <SearchSection
                  title="Models"
                  count={data.models.total}
                  icon={<Box size={14} style={{ color: 'var(--ax-fg-muted)' }} />}
                >
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                      gap: 14,
                    }}
                  >
                    {data.models.items.slice(0, SEARCH_LIMIT).map((model) => (
                      <ModelCard key={model.id} model={model} />
                    ))}
                  </div>
                  {data.models.total > data.models.items.length && (
                    <button
                      type="button"
                      onClick={() => navigate(`/?q=${encodeURIComponent(q)}`)}
                      style={{
                        marginTop: 12,
                        padding: '8px 12px',
                        borderRadius: 8,
                        background: 'transparent',
                        border: '1px solid var(--ax-border)',
                        color: 'var(--ax-fg)',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        fontSize: 12,
                      }}
                    >
                      Show all {data.models.total.toLocaleString()} models →
                    </button>
                  )}
                </SearchSection>
              )}

              {/* Collections */}
              {showCollections && data.collections.length > 0 && (
                <SearchSection
                  title="Collections"
                  count={data.collections.length}
                  icon={<Folder size={14} style={{ color: 'var(--ax-amber, #f59e0b)' }} />}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {data.collections.map((col) => (
                      <CollectionResultRow key={col.id} collection={col} />
                    ))}
                  </div>
                </SearchSection>
              )}

              {/* Artists */}
              {showArtists && data.artists.length > 0 && (
                <SearchSection
                  title="Artists"
                  count={data.artists.length}
                  icon={<User size={14} style={{ color: 'var(--ax-fg-muted)' }} />}
                >
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                      gap: 12,
                    }}
                  >
                    {data.artists.map((artist) => (
                      <ArtistResultCard key={artist.name} artist={artist} />
                    ))}
                  </div>
                </SearchSection>
              )}

              {/* Tags */}
              {showTags && data.tags.length > 0 && (
                <SearchSection
                  title="Tags"
                  count={data.tags.length}
                  icon={<Hash size={14} style={{ color: 'var(--ax-fg-muted)' }} />}
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {data.tags.map((tag) => (
                      <TagResultPill key={tag.name} tag={tag} />
                    ))}
                  </div>
                </SearchSection>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
