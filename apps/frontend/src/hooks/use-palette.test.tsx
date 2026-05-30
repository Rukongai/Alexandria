import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { PaletteProvider, usePalette, PALETTES } from './use-palette';

function wrapper({ children }: { children: React.ReactNode }) {
  return <PaletteProvider>{children}</PaletteProvider>;
}

describe('usePalette', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  it('defaults to slate and applies ax-palette-slate', () => {
    const { result } = renderHook(() => usePalette(), { wrapper });
    expect(result.current.palette).toBe('slate');
    expect(document.documentElement.classList.contains('ax-palette-slate')).toBe(true);
  });

  it('switches palette, swapping the root class and persisting', () => {
    const { result } = renderHook(() => usePalette(), { wrapper });
    act(() => result.current.setPalette('plum'));
    expect(document.documentElement.classList.contains('ax-palette-plum')).toBe(true);
    expect(document.documentElement.classList.contains('ax-palette-slate')).toBe(false);
    expect(localStorage.getItem('ax-palette')).toBe('plum');
  });

  it('exposes all five palettes', () => {
    expect(PALETTES).toEqual(['slate', 'workshop', 'sage', 'plum', 'graphite']);
  });
});
