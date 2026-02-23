import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type AspectRatio = '1/1' | '2/3' | '3/4' | '4/3';

interface DisplayPreferences {
  cardAspectRatio: AspectRatio;
  setCardAspectRatio: (ratio: AspectRatio) => void;
}

const STORAGE_KEY = 'displayPrefs';
const DEFAULT_RATIO: AspectRatio = '4/3';

function loadPrefs(): { cardAspectRatio: AspectRatio } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.cardAspectRatio) return parsed;
    }
  } catch {
    // ignore
  }
  return { cardAspectRatio: DEFAULT_RATIO };
}

const DisplayPreferencesContext = createContext<DisplayPreferences | null>(null);

export function DisplayPreferencesProvider({ children }: { children: ReactNode }) {
  const [cardAspectRatio, setRatioState] = useState<AspectRatio>(() => loadPrefs().cardAspectRatio);

  const setCardAspectRatio = useCallback((ratio: AspectRatio) => {
    setRatioState(ratio);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ cardAspectRatio: ratio }));
    } catch {
      // ignore storage errors
    }
  }, []);

  return (
    <DisplayPreferencesContext.Provider value={{ cardAspectRatio, setCardAspectRatio }}>
      {children}
    </DisplayPreferencesContext.Provider>
  );
}

export function useDisplayPreferences(): DisplayPreferences {
  const ctx = useContext(DisplayPreferencesContext);
  if (!ctx) throw new Error('useDisplayPreferences must be used within DisplayPreferencesProvider');
  return ctx;
}
