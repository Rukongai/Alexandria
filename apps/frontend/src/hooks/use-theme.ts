import React, { createContext, useContext, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: 'light' | 'dark';
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'theme';

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme): 'light' | 'dark' {
  const resolved = theme === 'system' ? getSystemTheme() : theme;
  const root = document.documentElement;
  if (resolved === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
  return resolved;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
      if (stored === 'light' || stored === 'dark' || stored === 'system') {
        return stored;
      }
    } catch {
      // localStorage not available
    }
    return 'system';
  });

  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(
    () => (theme === 'system' ? getSystemTheme() : theme)
  );

  // Apply theme on mount and when theme changes
  useEffect(() => {
    const resolved = applyTheme(theme);
    setResolvedTheme(resolved);
  }, [theme]);

  // Listen for system preference changes when theme is 'system'
  useEffect(() => {
    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    function handleChange() {
      const resolved = applyTheme('system');
      setResolvedTheme(resolved);
    }

    mediaQuery.addEventListener('change', handleChange);
    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, [theme]);

  function setTheme(newTheme: Theme) {
    try {
      localStorage.setItem(STORAGE_KEY, newTheme);
    } catch {
      // localStorage not available
    }
    setThemeState(newTheme);
  }

  return React.createElement(
    ThemeContext.Provider,
    { value: { theme, setTheme, resolvedTheme } },
    children
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
