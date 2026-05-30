import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { DisplayPreferencesProvider, useDisplayPreferences } from './use-display-preferences';

function wrapper({ children }: { children: React.ReactNode }) {
  return <DisplayPreferencesProvider>{children}</DisplayPreferencesProvider>;
}

describe('useDisplayPreferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to 4/3 ratio, grid view, and showThumbnails true when storage is empty', () => {
    const { result } = renderHook(() => useDisplayPreferences(), { wrapper });
    expect(result.current.cardAspectRatio).toBe('4/3');
    expect(result.current.view).toBe('grid');
    expect(result.current.showThumbnails).toBe(true);
  });

  it('is backward-compatible: existing blob with only cardAspectRatio loads with view=grid and showThumbnails=true', () => {
    localStorage.setItem('displayPrefs', JSON.stringify({ cardAspectRatio: '2/3' }));
    const { result } = renderHook(() => useDisplayPreferences(), { wrapper });
    expect(result.current.cardAspectRatio).toBe('2/3');
    expect(result.current.view).toBe('grid');
    expect(result.current.showThumbnails).toBe(true);
  });

  it('setView persists the new view and does not clobber cardAspectRatio or showThumbnails', () => {
    localStorage.setItem(
      'displayPrefs',
      JSON.stringify({ cardAspectRatio: '3/4', view: 'grid', showThumbnails: true })
    );
    const { result } = renderHook(() => useDisplayPreferences(), { wrapper });

    act(() => result.current.setView('list'));

    expect(result.current.view).toBe('list');
    expect(result.current.cardAspectRatio).toBe('3/4');
    expect(result.current.showThumbnails).toBe(true);

    const stored = JSON.parse(localStorage.getItem('displayPrefs')!);
    expect(stored.view).toBe('list');
    expect(stored.cardAspectRatio).toBe('3/4');
    expect(stored.showThumbnails).toBe(true);
  });

  it('setShowThumbnails persists the new value and does not clobber cardAspectRatio or view', () => {
    localStorage.setItem(
      'displayPrefs',
      JSON.stringify({ cardAspectRatio: '1/1', view: 'group', showThumbnails: true })
    );
    const { result } = renderHook(() => useDisplayPreferences(), { wrapper });

    act(() => result.current.setShowThumbnails(false));

    expect(result.current.showThumbnails).toBe(false);
    expect(result.current.cardAspectRatio).toBe('1/1');
    expect(result.current.view).toBe('group');

    const stored = JSON.parse(localStorage.getItem('displayPrefs')!);
    expect(stored.showThumbnails).toBe(false);
    expect(stored.cardAspectRatio).toBe('1/1');
    expect(stored.view).toBe('group');
  });

  it('setCardAspectRatio persists the new ratio and does not clobber view or showThumbnails', () => {
    localStorage.setItem(
      'displayPrefs',
      JSON.stringify({ cardAspectRatio: '1/1', view: 'list', showThumbnails: false })
    );
    const { result } = renderHook(() => useDisplayPreferences(), { wrapper });

    act(() => result.current.setCardAspectRatio('2/3'));

    expect(result.current.cardAspectRatio).toBe('2/3');
    expect(result.current.view).toBe('list');
    expect(result.current.showThumbnails).toBe(false);

    const stored = JSON.parse(localStorage.getItem('displayPrefs')!);
    expect(stored.cardAspectRatio).toBe('2/3');
    expect(stored.view).toBe('list');
    expect(stored.showThumbnails).toBe(false);
  });

  it('tolerates garbage values in localStorage by falling back to defaults', () => {
    localStorage.setItem('displayPrefs', 'not-json{{{');
    const { result } = renderHook(() => useDisplayPreferences(), { wrapper });
    expect(result.current.cardAspectRatio).toBe('4/3');
    expect(result.current.view).toBe('grid');
    expect(result.current.showThumbnails).toBe(true);
  });

  it('throws when used outside DisplayPreferencesProvider', () => {
    expect(() => {
      renderHook(() => useDisplayPreferences());
    }).toThrow('useDisplayPreferences must be used within DisplayPreferencesProvider');
  });
});
