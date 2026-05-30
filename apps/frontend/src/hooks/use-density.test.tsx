import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { DensityProvider, useDensity, DENSITIES } from './use-density';

function wrapper({ children }: { children: React.ReactNode }) {
  return <DensityProvider>{children}</DensityProvider>;
}

describe('useDensity', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  it('defaults to cozy with NO density class (cozy is the token base)', () => {
    const { result } = renderHook(() => useDensity(), { wrapper });
    expect(result.current.density).toBe('cozy');
    expect(document.documentElement.classList.contains('ax-density-cozy')).toBe(false);
    expect(document.documentElement.classList.contains('ax-density-compact')).toBe(false);
    expect(document.documentElement.classList.contains('ax-density-comfy')).toBe(false);
  });

  it('applies ax-density-compact when set to compact and persists', () => {
    const { result } = renderHook(() => useDensity(), { wrapper });
    act(() => result.current.setDensity('compact'));
    expect(document.documentElement.classList.contains('ax-density-compact')).toBe(true);
    expect(localStorage.getItem('ax-density')).toBe('compact');
  });

  it('switching back to cozy removes the density class', () => {
    const { result } = renderHook(() => useDensity(), { wrapper });
    act(() => result.current.setDensity('comfy'));
    act(() => result.current.setDensity('cozy'));
    expect(document.documentElement.classList.contains('ax-density-comfy')).toBe(false);
    expect(document.documentElement.classList.contains('ax-density-cozy')).toBe(false);
  });

  it('exposes all three densities', () => {
    expect(DENSITIES).toEqual(['compact', 'cozy', 'comfy']);
  });
});
