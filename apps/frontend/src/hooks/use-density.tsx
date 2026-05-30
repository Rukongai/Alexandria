import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export const DENSITIES = ['compact', 'cozy', 'comfy'] as const;
export type Density = (typeof DENSITIES)[number];

const STORAGE_KEY = 'ax-density';
const DEFAULT_DENSITY: Density = 'cozy';

interface DensityContextValue {
  density: Density;
  setDensity: (d: Density) => void;
}

const DensityContext = createContext<DensityContextValue | null>(null);

function isDensity(v: unknown): v is Density {
  return typeof v === 'string' && (DENSITIES as readonly string[]).includes(v);
}

function applyDensity(density: Density) {
  const root = document.documentElement;
  for (const d of DENSITIES) root.classList.remove(`ax-density-${d}`);
  // 'cozy' is the token base (no modifier class needed).
  if (density !== 'cozy') root.classList.add(`ax-density-${density}`);
}

export function DensityProvider({ children }: { children: ReactNode }) {
  const [density, setDensityState] = useState<Density>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (isDensity(stored)) return stored;
    } catch {
      // localStorage unavailable
    }
    return DEFAULT_DENSITY;
  });

  useEffect(() => {
    applyDensity(density);
  }, [density]);

  function setDensity(d: Density) {
    try {
      localStorage.setItem(STORAGE_KEY, d);
    } catch {
      // ignore
    }
    setDensityState(d);
  }

  return (
    <DensityContext.Provider value={{ density, setDensity }}>{children}</DensityContext.Provider>
  );
}

export function useDensity(): DensityContextValue {
  const ctx = useContext(DensityContext);
  if (!ctx) throw new Error('useDensity must be used within a DensityProvider');
  return ctx;
}
