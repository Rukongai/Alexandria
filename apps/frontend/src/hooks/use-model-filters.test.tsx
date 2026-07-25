import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useModelFilters } from './use-model-filters';
import type { ModelFilters } from './use-model-filters';

function makeWrapper(initialEntries: string[] = ['/']) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>;
  };
}

describe('useModelFilters — axis (pivot UI state)', () => {
  it('defaults axis to "collections" when no ?axis= param is present', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/']),
    });
    expect(result.current.axis).toBe('collections');
  });

  it('reads axis="tags" from the URL', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?axis=tags']),
    });
    expect(result.current.axis).toBe('tags');
  });

  it('reads axis="artists" from the URL', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?axis=artists']),
    });
    expect(result.current.axis).toBe('artists');
  });

  it('falls back to "collections" for an unknown axis value', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?axis=unknown']),
    });
    expect(result.current.axis).toBe('collections');
  });

  it('parses a metadata-prefixed axis from the URL', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?axis=metadata%3Ascale&meta_scale=1%3A12']),
    });

    expect(result.current.axis).toBe('metadata:scale');
    expect(result.current.activeAxisValue.metadata).toEqual({ slug: 'scale', value: '1:12' });
  });

  it('falls back to collections for an empty metadata axis slug', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?axis=metadata%3A']),
    });
    expect(result.current.axis).toBe('collections');
  });

  it.each(['artist', 'tags'])('reserves metadata:%s for its built-in axis', (slug) => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper([`/?axis=metadata%3A${slug}`]),
    });
    expect(result.current.axis).toBe('collections');
    expect(result.current.activeAxisValue.metadata).toBeUndefined();
  });

  it('rejects an overlong metadata axis slug', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper([`/?axis=${encodeURIComponent(`metadata:${'x'.repeat(256)}`)}`]),
    });
    expect(result.current.axis).toBe('collections');
  });

  it('accepts a nonempty backend-generated leading-hyphen slug', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?axis=metadata%3A-abcd']),
    });
    expect(result.current.axis).toBe('metadata:-abcd');
  });

  it('setAxis("tags") adds ?axis=tags while preserving other params', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?q=vase&sort=name']),
    });

    act(() => result.current.setAxis('tags'));

    expect(result.current.axis).toBe('tags');
    // other filters must be intact
    expect(result.current.filters.q).toBe('vase');
    expect(result.current.filters.sort).toBe('name');
  });

  it('setAxis("collections") removes the ?axis= param (default omitted for clean URLs)', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?axis=artists&q=robot']),
    });

    act(() => result.current.setAxis('collections'));

    expect(result.current.axis).toBe('collections');
    // q param must still be there
    expect(result.current.filters.q).toBe('robot');
  });

  it('axis does NOT appear in toApiParams() output', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?axis=tags&q=boat']),
    });
    const apiParams = result.current.toApiParams();
    expect(apiParams).not.toHaveProperty('axis');
  });

  it('axis is NOT a key of the filters object', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?axis=artists']),
    });
    // Verify at runtime that filters does not contain axis
    const filters: ModelFilters = result.current.filters;
    expect(Object.keys(filters)).not.toContain('axis');
  });
});

describe('useModelFilters — activeAxisValue', () => {
  it('returns collectionId for axis="collections"', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?collectionId=col-1']),
    });
    expect(result.current.axis).toBe('collections');
    expect(result.current.activeAxisValue.collectionId).toBe('col-1');
    expect(result.current.activeAxisValue.artist).toBeUndefined();
    expect(result.current.activeAxisValue.tags).toEqual([]);
  });

  it('returns artist for axis="artists"', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?axis=artists&meta_artist=Prusa']),
    });
    expect(result.current.activeAxisValue.artist).toBe('Prusa');
    expect(result.current.activeAxisValue.collectionId).toBeUndefined();
    expect(result.current.activeAxisValue.tags).toEqual([]);
  });

  it('returns tags array for axis="tags"', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?axis=tags&tags=miniature,terrain']),
    });
    expect(result.current.activeAxisValue.tags).toEqual(['miniature', 'terrain']);
    expect(result.current.activeAxisValue.collectionId).toBeUndefined();
    expect(result.current.activeAxisValue.artist).toBeUndefined();
  });

  it('returns empty activeAxisValue when no values are selected', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/']),
    });
    expect(result.current.activeAxisValue.collectionId).toBeUndefined();
    expect(result.current.activeAxisValue.artist).toBeUndefined();
    expect(result.current.activeAxisValue.tags).toEqual([]);
  });
});

describe('useModelFilters — existing filter behavior unchanged', () => {
  it('builds filters from URL params', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?q=vase&tags=tag1,tag2&collectionId=col-99&sort=name&sortDir=asc']),
    });
    const { filters } = result.current;
    expect(filters.q).toBe('vase');
    expect(filters.tags).toEqual(['tag1', 'tag2']);
    expect(filters.collectionId).toBe('col-99');
    expect(filters.sort).toBe('name');
    expect(filters.sortDir).toBe('asc');
  });

  it('toApiParams() maps filters to API shape', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?q=boat&tags=a,b&collectionId=col-1']),
    });
    const params = result.current.toApiParams('cursor-abc');
    expect(params.q).toBe('boat');
    expect(params.tags).toBe('a,b');
    expect(params.collectionId).toBe('col-1');
    expect(params.cursor).toBe('cursor-abc');
    expect(params).not.toHaveProperty('axis');
  });

  it('hasActiveFilters is false on a clean URL', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/']),
    });
    expect(result.current.hasActiveFilters).toBe(false);
  });

  it('hasActiveFilters is true when a filter is set (axis alone does not count)', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?axis=tags&q=hello']),
    });
    expect(result.current.hasActiveFilters).toBe(true);
  });

  it('hasActiveFilters remains false when only axis is set', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?axis=tags']),
    });
    expect(result.current.hasActiveFilters).toBe(false);
  });

  it('clearAllFilters preserves the current axis param', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?axis=artists&q=robot&collectionId=col-1']),
    });

    expect(result.current.hasActiveFilters).toBe(true);

    act(() => result.current.clearAllFilters());

    // axis should be preserved
    expect(result.current.axis).toBe('artists');
    // all content filters should be cleared
    expect(result.current.filters.q).toBe('');
    expect(result.current.filters.collectionId).toBeUndefined();
    expect(result.current.hasActiveFilters).toBe(false);
  });

  it('clearAllFilters on a clean URL (no axis) leaves URL clean', () => {
    const { result } = renderHook(() => useModelFilters(), {
      wrapper: makeWrapper(['/?q=vase']),
    });

    act(() => result.current.clearAllFilters());

    // default axis is still reported (no ?axis= in URL)
    expect(result.current.axis).toBe('collections');
    expect(result.current.filters.q).toBe('');
  });
});
