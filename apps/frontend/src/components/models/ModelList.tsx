import { useNavigate } from 'react-router-dom';
import { Package, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import type { ModelCard } from '@alexandria/shared';
import { formatFileSize } from '../../lib/format';
import { cn } from '../../lib/utils';
import { useLibraryPath } from '../../hooks/use-libraries';

interface ModelRowProps {
  model: ModelCard;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  showThumbnails?: boolean;
}

function ModelRow({ model, selectable, selected, onToggleSelect, showThumbnails = true }: ModelRowProps) {
  const navigate = useNavigate();
  const libPath = useLibraryPath();

  const artist = model.metadata.find((m) => m.fieldSlug === 'artist');
  const artistName = artist
    ? (Array.isArray(artist.value) ? artist.value[0] : artist.value)
    : null;

  const year = model.metadata.find((m) => m.fieldSlug === 'year');
  const yearValue = year ? (Array.isArray(year.value) ? year.value[0] : year.value) : null;

  const tags = model.metadata
    .filter((m) => m.fieldSlug === 'tags')
    .flatMap((m) => (Array.isArray(m.value) ? m.value : [m.value]))
    .slice(0, 2);

  const thumbnailSrc = model.thumbnailUrl ? `/api${model.thumbnailUrl}` : null;

  function handleClick(e: React.MouseEvent | React.KeyboardEvent) {
    if (selectable) {
      e.preventDefault();
      onToggleSelect?.(model.id);
      return;
    }
    navigate(libPath(`/models/${model.id}`));
  }

  return (
    <div
      role="row"
      aria-selected={selectable ? selected : undefined}
      tabIndex={0}
      onClick={handleClick as React.MouseEventHandler}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick(e);
        }
      }}
      className={cn(
        'group flex items-center gap-3 px-3 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset',
        selected
          ? 'bg-primary/10 hover:bg-primary/15'
          : 'hover:bg-[var(--ax-bg-sunk,hsl(var(--muted)))]'
      )}
      style={{
        height: 'var(--ax-row-h, 40px)',
        borderBottom: '1px solid var(--ax-border, hsl(var(--border)))',
        fontSize: 12.5,
        color: 'var(--ax-fg, hsl(var(--foreground)))',
        background: selected
          ? 'color-mix(in srgb, var(--ax-teal, hsl(var(--primary))) 12%, transparent)'
          : undefined,
      }}
      aria-label={
        selectable
          ? `${selected ? 'Deselect' : 'Select'} model: ${model.name}`
          : `View model: ${model.name}`
      }
    >
      {/* Selection checkbox */}
      {selectable && (
        <div
          className={cn(
            'flex-shrink-0 h-4 w-4 rounded-full border-2 flex items-center justify-center transition-opacity',
            selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
          style={{
            background: selected ? 'var(--ax-teal, hsl(var(--primary)))' : 'var(--ax-bg-elev, hsl(var(--background)))',
            borderColor: selected ? 'var(--ax-teal, hsl(var(--primary)))' : 'var(--ax-border, hsl(var(--border)))',
          }}
          aria-hidden
        >
          {selected && <CheckCircle2 className="h-3 w-3 text-white" />}
        </div>
      )}

      {/* Thumbnail */}
      <div
        className="flex-shrink-0 rounded overflow-hidden"
        style={{
          width: 36,
          height: 28,
          background: 'var(--ax-bg-sunk, hsl(var(--muted)))',
        }}
      >
        {showThumbnails && thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          showThumbnails && (
            <div className="flex h-full w-full items-center justify-center">
              <Package
                className="h-3.5 w-3.5"
                style={{ color: 'var(--ax-fg-subtle, hsl(var(--muted-foreground)))' }}
              />
            </div>
          )
        )}
      </div>

      {/* Name — flex-1, truncated */}
      <div
        className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium"
        title={model.name}
      >
        {model.name}
      </div>

      {/* Artist — fixed 140px */}
      <div
        className="flex-shrink-0 overflow-hidden text-ellipsis whitespace-nowrap"
        style={{ width: 140, color: 'var(--ax-fg-muted, hsl(var(--muted-foreground)))' }}
        title={artistName ?? ''}
      >
        {artistName ?? ''}
      </div>

      {/* Year — fixed 72px */}
      <div
        className="flex-shrink-0 font-mono text-[11px]"
        style={{ width: 72, color: 'var(--ax-fg-muted, hsl(var(--muted-foreground)))' }}
      >
        {yearValue ?? ''}
      </div>

      {/* File count — fixed 60px */}
      <div
        className="flex-shrink-0 font-mono text-[11px]"
        style={{ width: 60, color: 'var(--ax-fg-muted, hsl(var(--muted-foreground)))' }}
      >
        {model.fileCount}f
      </div>

      {/* Size — fixed 80px */}
      <div
        className="flex-shrink-0 font-mono text-[11px]"
        style={{ width: 80, color: 'var(--ax-fg-muted, hsl(var(--muted-foreground)))' }}
      >
        {formatFileSize(model.totalSizeBytes)}
      </div>

      {/* Status */}
      <div
        className="flex-shrink-0 flex items-center gap-1"
        style={{ width: 72 }}
      >
        {model.status === 'processing' && (
          <Loader2
            className="h-3 w-3 animate-spin"
            style={{ color: 'var(--ax-warning, hsl(var(--warning, 38 92% 50%)))' }}
          />
        )}
        {model.status === 'error' && (
          <AlertCircle className="h-3 w-3 text-destructive" />
        )}
      </div>

      {/* Tags — fixed 120px, right-aligned */}
      <div
        className="flex-shrink-0 flex items-center gap-1 justify-end overflow-hidden"
        style={{ width: 120 }}
      >
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-block truncate rounded px-1.5 py-0.5 text-[11px]"
            style={{
              height: 18,
              lineHeight: '18px',
              maxWidth: 56,
              background: 'var(--ax-bg-sunk, hsl(var(--muted)))',
              border: '1px solid var(--ax-border, hsl(var(--border)))',
              color: 'var(--ax-fg-muted, hsl(var(--muted-foreground)))',
            }}
          >
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface ModelListProps {
  models: ModelCard[];
  selectable?: boolean;
  isSelected?: (id: string) => boolean;
  onToggleSelect?: (id: string) => void;
  showThumbnails?: boolean;
}

/**
 * Dense row (list) view of models.
 * Columns: thumbnail | name | artist | year | file count | size | status | tags
 *
 * Mirrors ModelCard selection behavior — rows are clickable to navigate when
 * not selectable, and toggle selection when in bulk mode.
 */
export function ModelList({
  models,
  selectable,
  isSelected,
  onToggleSelect,
  showThumbnails = true,
}: ModelListProps) {
  return (
    <div
      role="rowgroup"
      style={{
        border: '1px solid var(--ax-border, hsl(var(--border)))',
        borderRadius: 8,
        overflow: 'hidden',
        background: 'var(--ax-bg-elev, hsl(var(--card)))',
      }}
    >
      {/* Column header */}
      <div
        className="flex items-center gap-3 px-3"
        style={{
          height: 32,
          borderBottom: '1px solid var(--ax-border, hsl(var(--border)))',
          background: 'var(--ax-bg-sunk, hsl(var(--muted)))',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--ax-fg-muted, hsl(var(--muted-foreground)))',
        }}
        role="row"
        aria-hidden
      >
        {selectable && <div style={{ width: 16, flexShrink: 0 }} />}
        <div style={{ width: 36, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>Name</div>
        <div style={{ width: 140, flexShrink: 0 }}>Artist</div>
        <div style={{ width: 72, flexShrink: 0 }}>Year</div>
        <div style={{ width: 60, flexShrink: 0 }}>Files</div>
        <div style={{ width: 80, flexShrink: 0 }}>Size</div>
        <div style={{ width: 72, flexShrink: 0 }}>Status</div>
        <div style={{ width: 120, flexShrink: 0, textAlign: 'right' }}>Tags</div>
      </div>

      {models.map((model) => (
        <ModelRow
          key={model.id}
          model={model}
          selectable={selectable}
          selected={isSelected?.(model.id) ?? false}
          onToggleSelect={onToggleSelect}
          showThumbnails={showThumbnails}
        />
      ))}
    </div>
  );
}
