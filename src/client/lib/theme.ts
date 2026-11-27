import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

export const THEME_STORAGE_KEY = 'travel:color-scheme';
export const THEME_CHANGE_EVENT = 'travel:theme-change';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedScheme = 'light' | 'dark';

export function getThemePreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch {
    /* Ignore storage access errors. */
  }
  return 'system';
}

export function getSystemScheme(): ResolvedScheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveScheme(pref: ThemePreference): ResolvedScheme {
  return pref === 'system' ? getSystemScheme() : pref;
}

export function syncDomTheme(pref: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (pref === 'light' || pref === 'dark') {
    if (meta) meta.setAttribute('content', pref);
    document.documentElement.dataset.theme = pref;
  } else {
    if (meta) meta.setAttribute('content', 'light dark');
    delete document.documentElement.dataset.theme;
  }
}

export function setThemePreference(pref: ThemePreference): void {
  try {
    if (pref === 'system') {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, pref);
    }
  } catch {
    /* Ignore storage access errors. */
  }
  syncDomTheme(pref);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
  }
}

export function toggleTwoStateTheme(): ThemePreference {
  const current = resolveScheme(getThemePreference());
  const system = getSystemScheme();
  const target: ResolvedScheme = current === 'dark' ? 'light' : 'dark';
  const nextPref: ThemePreference = target === system ? 'system' : target;

  flushSync(() => {
    setThemePreference(nextPref);
  });
  return nextPref;
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => getThemePreference());
  const [resolved, setResolved] = useState<ResolvedScheme>(() =>
    resolveScheme(getThemePreference()),
  );

  useEffect(() => {
    const sync = () => {
      const nextPref = getThemePreference();
      syncDomTheme(nextPref);
      setPreferenceState(nextPref);
      setResolved(resolveScheme(nextPref));
    };

    const mediaQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;

    const handleMediaChange = () => {
      // Never delete stored preference when OS theme happens to match it.
      const nextPref = getThemePreference();
      setPreferenceState(nextPref);
      setResolved(resolveScheme(nextPref));
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        sync();
      }
    };

    mediaQuery?.addEventListener('change', handleMediaChange);
    window.addEventListener('storage', handleStorage);
    window.addEventListener(THEME_CHANGE_EVENT, sync);

    return () => {
      mediaQuery?.removeEventListener('change', handleMediaChange);
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(THEME_CHANGE_EVENT, sync);
    };
  }, []);

  const toggle = useCallback(() => {
    toggleTwoStateTheme();
  }, []);

  const setPreference = useCallback((pref: ThemePreference) => {
    setThemePreference(pref);
  }, []);

  return { preference, resolved, toggle, setPreference };
}
