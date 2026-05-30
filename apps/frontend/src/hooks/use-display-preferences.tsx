import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type AspectRatio = '1/1' | '2/3' | '3/4' | '4/3';
export type ViewMode = 'grid' | 'list' | 'group';

interface DisplayPreferences {
  cardAspectRatio: AspectRatio;
  setCardAspectRatio: (ratio: AspectRatio) => void;
  view: ViewMode;
  setView: (v: ViewMode) => void;
  showThumbnails: boolean;
  setShowThumbnails: (b: boolean) => void;
}

interface PersistedPrefs {
  cardAspectRatio: AspectRatio;
  view: ViewMode;
  showThumbnails: boolean;
}

const STORAGE_KEY = 'displayPrefs';
const DEFAULT_RATIO: AspectRatio = '4/3';
const DEFAULT_VIEW: ViewMode = 'grid';
const DEFAULT_SHOW_THUMBNAILS = true;

const VALID_RATIOS: AspectRatio[] = ['1/1', '2/3', '3/4', '4/3'];
const VALID_VIEWS: ViewMode[] = ['grid', 'list', 'group'];

function loadPrefs(): PersistedPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedPrefs>;
      const cardAspectRatio: AspectRatio =
        parsed.cardAspectRatio && VALID_RATIOS.includes(parsed.cardAspectRatio)
          ? parsed.cardAspectRatio
          : DEFAULT_RATIO;
      const view: ViewMode =
        parsed.view && VALID_VIEWS.includes(parsed.view) ? parsed.view : DEFAULT_VIEW;
      const showThumbnails: boolean =
        typeof parsed.showThumbnails === 'boolean' ? parsed.showThumbnails : DEFAULT_SHOW_THUMBNAILS;
      return { cardAspectRatio, view, showThumbnails };
    }
  } catch {
    // ignore parse/storage errors
  }
  return { cardAspectRatio: DEFAULT_RATIO, view: DEFAULT_VIEW, showThumbnails: DEFAULT_SHOW_THUMBNAILS };
}

function savePrefs(prefs: PersistedPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage errors
  }
}

const DisplayPreferencesContext = createContext<DisplayPreferences | null>(null);

export function DisplayPreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<PersistedPrefs>(() => loadPrefs());

  const setCardAspectRatio = useCallback((ratio: AspectRatio) => {
    setPrefs((prev) => {
      const next = { ...prev, cardAspectRatio: ratio };
      savePrefs(next);
      return next;
    });
  }, []);

  const setView = useCallback((view: ViewMode) => {
    setPrefs((prev) => {
      const next = { ...prev, view };
      savePrefs(next);
      return next;
    });
  }, []);

  const setShowThumbnails = useCallback((showThumbnails: boolean) => {
    setPrefs((prev) => {
      const next = { ...prev, showThumbnails };
      savePrefs(next);
      return next;
    });
  }, []);

  return (
    <DisplayPreferencesContext.Provider
      value={{
        cardAspectRatio: prefs.cardAspectRatio,
        setCardAspectRatio,
        view: prefs.view,
        setView,
        showThumbnails: prefs.showThumbnails,
        setShowThumbnails,
      }}
    >
      {children}
    </DisplayPreferencesContext.Provider>
  );
}

export function useDisplayPreferences(): DisplayPreferences {
  const ctx = useContext(DisplayPreferencesContext);
  if (!ctx) throw new Error('useDisplayPreferences must be used within DisplayPreferencesProvider');
  return ctx;
}
