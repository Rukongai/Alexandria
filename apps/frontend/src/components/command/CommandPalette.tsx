import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Package, Folder, ArrowRight } from 'lucide-react';
import { Dialog, DialogContent } from '../ui/dialog';
import { useCommandPalette } from '../../hooks/use-command-palette';
import { useGlobalSearch } from '../../hooks/use-global-search';

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export function CommandPalette() {
  const { isOpen, close } = useCommandPalette();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  const [inputValue, setInputValue] = useState('');
  const debouncedQ = useDebounce(inputValue, 200);

  const { data } = useGlobalSearch(debouncedQ, 4);

  // Build a flat list of selectable items for keyboard nav
  const items: Array<{ type: 'search' | 'model' | 'collection'; label: string; sub?: string; action: () => void }> = [];

  if (debouncedQ.trim().length > 0) {
    items.push({
      type: 'search',
      label: `Search everything for "${debouncedQ}"`,
      action: () => {
        navigate(`/search?q=${encodeURIComponent(debouncedQ)}`);
        close();
      },
    });
  }

  if (data) {
    for (const model of data.models.items.slice(0, 4)) {
      items.push({
        type: 'model',
        label: model.name,
        sub: `${model.fileCount} ${model.fileCount === 1 ? 'file' : 'files'}`,
        action: () => {
          navigate(`/models/${model.id}`);
          close();
        },
      });
    }
    for (const col of data.collections.slice(0, 3)) {
      items.push({
        type: 'collection',
        label: col.name,
        sub: `${col.modelCount} ${col.modelCount === 1 ? 'model' : 'models'}`,
        action: () => {
          navigate(`/collections/${col.id}`);
          close();
        },
      });
    }
  }

  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0);
  }, [debouncedQ]);

  // Focus the input when dialog opens
  useEffect(() => {
    if (isOpen) {
      setInputValue('');
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && items.length > 0) {
      e.preventDefault();
      items[selectedIndex]?.action();
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent
        className="p-0 gap-0 overflow-hidden"
        style={{
          maxWidth: 560,
          background: 'var(--ax-bg)',
          border: '1px solid var(--ax-border)',
          borderRadius: 14,
        }}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 16px',
            borderBottom: items.length > 0 ? '1px solid var(--ax-border)' : 'none',
          }}
        >
          <Search size={16} style={{ color: 'var(--ax-fg-muted)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search models, collections…"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              outline: 'none',
              fontSize: 15,
              color: 'var(--ax-fg)',
              fontFamily: 'inherit',
            }}
            aria-label="Command palette search"
            aria-autocomplete="list"
            aria-expanded={items.length > 0}
          />
          {inputValue && (
            <button
              type="button"
              onClick={() => setInputValue('')}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--ax-fg-muted)',
                padding: 2,
                fontFamily: 'inherit',
                fontSize: 12,
              }}
              aria-label="Clear search"
            >
              esc
            </button>
          )}
        </div>

        {/* Results list */}
        {items.length > 0 && (
          <div
            role="listbox"
            aria-label="Search results"
            style={{ maxHeight: 340, overflowY: 'auto', padding: '6px 0' }}
          >
            {items.map((item, i) => (
              <div
                key={`${item.type}-${item.label}`}
                role="option"
                aria-selected={i === selectedIndex}
                onClick={item.action}
                onMouseEnter={() => setSelectedIndex(i)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 16px',
                  cursor: 'pointer',
                  background: i === selectedIndex ? 'var(--ax-bg-elev)' : 'transparent',
                  transition: 'background 0.1s',
                }}
              >
                {/* Type icon */}
                <span
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 7,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    background:
                      item.type === 'search'
                        ? 'var(--ax-bg-sunk)'
                        : item.type === 'collection'
                        ? 'var(--ax-amber-tint)'
                        : 'var(--ax-bg-sunk)',
                    color:
                      item.type === 'collection'
                        ? 'var(--ax-amber-tint-fg)'
                        : 'var(--ax-fg-muted)',
                  }}
                >
                  {item.type === 'search' && <Search size={13} />}
                  {item.type === 'model' && <Package size={13} />}
                  {item.type === 'collection' && <Folder size={13} />}
                </span>

                {/* Labels */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13.5,
                      fontWeight: item.type === 'search' ? 500 : 600,
                      color:
                        item.type === 'search'
                          ? 'var(--ax-fg-muted)'
                          : 'var(--ax-fg)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {item.label}
                  </div>
                  {item.sub && (
                    <div className="ax-mono" style={{ fontSize: 11, color: 'var(--ax-fg-muted)' }}>
                      {item.sub}
                    </div>
                  )}
                </div>

                {i === selectedIndex && (
                  <ArrowRight size={12} style={{ color: 'var(--ax-fg-muted)', flexShrink: 0 }} />
                )}
              </div>
            ))}
          </div>
        )}

        {/* Empty state for typed query with no results yet */}
        {inputValue.trim().length > 0 && items.length === 0 && (
          <div
            style={{
              padding: '32px 16px',
              textAlign: 'center',
              fontSize: 13,
              color: 'var(--ax-fg-muted)',
            }}
          >
            No results for "{inputValue}"
          </div>
        )}

        {/* Prompt when empty */}
        {inputValue.trim().length === 0 && (
          <div
            style={{
              padding: '28px 16px',
              textAlign: 'center',
              fontSize: 13,
              color: 'var(--ax-fg-muted)',
            }}
          >
            Type to search models, collections, artists, and tags
          </div>
        )}

        {/* Keyboard hint footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '8px 16px',
            borderTop: '1px solid var(--ax-border)',
            fontSize: 11,
            color: 'var(--ax-fg-muted)',
          }}
        >
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
