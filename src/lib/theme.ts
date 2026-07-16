// Shared light/dark/auto theme logic. Storage key and semantics (null = auto,
// follow system preference) are unchanged from the original implementation so
// existing stored preferences keep working.
export type ThemePreference = 'light' | 'dark' | null;

const THEME_KEY = 'takalot-theme';

export function getStoredTheme(): ThemePreference {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === 'light' || stored === 'dark' ? stored : null;
}

export function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function isEffectivelyDark(pref: ThemePreference): boolean {
  return pref ? pref === 'dark' : systemPrefersDark();
}

export function applyTheme(): void {
  const dark = isEffectivelyDark(getStoredTheme());
  document.documentElement.classList.toggle('dark', dark);
}

export function setTheme(pref: ThemePreference): void {
  if (pref) localStorage.setItem(THEME_KEY, pref);
  else localStorage.removeItem(THEME_KEY);
  applyTheme();
}
