import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

/** The effective theme right now, resolved the way the CSS resolves it: an
 *  explicit choice on <html> wins, and absent one the OS preference does. */
function resolveThemeMode(): Theme {
  if (typeof document === 'undefined') return 'light';
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
    : 'light';
}

/**
 * Read-only "which theme are we painting in", for the charts — which pick their
 * own colours in JS (the era ramps in utils/eras) rather than off CSS variables,
 * so they have to redraw when the theme flips.
 *
 * Deliberately NOT useTheme(): that hook owns a private useState, so a third
 * component calling it would get a copy that never hears SettingsMenu's toggle.
 * The one thing every instance does agree on is the `data-theme` attribute on
 * <html> — the pre-mount script in index.html sets it and useTheme's effect
 * keeps it current — so that attribute is what this watches, plus the media
 * query for the case where no explicit choice was ever made and the attribute
 * is absent.
 */
export function useThemeMode(): Theme {
  const [mode, setMode] = useState<Theme>(resolveThemeMode);

  useEffect(() => {
    const sync = () => setMode(resolveThemeMode());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener('change', sync);
    // useTheme's own effect may have written the attribute between this
    // component's first render and this effect running.
    sync();
    return () => {
      observer.disconnect();
      mq?.removeEventListener('change', sync);
    };
  }, []);

  return mode;
}

// Resolve the effective theme on first render: an explicit saved choice wins,
// otherwise fall back to the OS preference. The pre-mount script in index.html
// has already applied any saved choice to <html>, so there's no flash.
function getInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* ignore */
  }
  if (typeof window !== 'undefined' && window.matchMedia)
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  return 'light';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggleTheme = useCallback(
    () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    []
  );

  return { theme, toggleTheme };
}
