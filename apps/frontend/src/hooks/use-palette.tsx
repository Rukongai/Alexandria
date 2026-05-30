import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export const PALETTES = ['slate', 'workshop', 'sage', 'plum', 'graphite'] as const;
export type Palette = (typeof PALETTES)[number];

const STORAGE_KEY = 'ax-palette';
const DEFAULT_PALETTE: Palette = 'slate';

interface PaletteContextValue {
  palette: Palette;
  setPalette: (p: Palette) => void;
}

const PaletteContext = createContext<PaletteContextValue | null>(null);

function isPalette(v: unknown): v is Palette {
  return typeof v === 'string' && (PALETTES as readonly string[]).includes(v);
}

function applyPalette(palette: Palette) {
  const root = document.documentElement;
  for (const p of PALETTES) root.classList.remove(`ax-palette-${p}`);
  root.classList.add(`ax-palette-${palette}`);
}

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [palette, setPaletteState] = useState<Palette>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (isPalette(stored)) return stored;
    } catch {
      // localStorage unavailable
    }
    return DEFAULT_PALETTE;
  });

  useEffect(() => {
    applyPalette(palette);
  }, [palette]);

  function setPalette(p: Palette) {
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      // ignore
    }
    setPaletteState(p);
  }

  return (
    <PaletteContext.Provider value={{ palette, setPalette }}>{children}</PaletteContext.Provider>
  );
}

export function usePalette(): PaletteContextValue {
  const ctx = useContext(PaletteContext);
  if (!ctx) throw new Error('usePalette must be used within a PaletteProvider');
  return ctx;
}
