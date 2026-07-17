import { useEffect, useState } from 'react';
import { getStoredTheme, isEffectivelyDark, setTheme } from '../lib/theme';
import { IconMoon, IconSun } from './icons';

/**
 * Compact direct display-mode toggle — no dropdown, no layout change. Shows
 * the icon for the mode a click will switch TO (sun while dark, moon while
 * light). With no stored preference yet, the effective mode follows the OS;
 * the first click stores an explicit choice that then persists across reloads.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [pref, setPref] = useState(() => getStoredTheme());
  // Re-renders on OS theme changes so an unset (auto) preference keeps
  // following the system live, without itself being read below — the
  // actual value comes fresh from isEffectivelyDark() on every render.
  const [, forceRerender] = useState(0);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => forceRerender((n) => n + 1);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const dark = isEffectivelyDark(pref);

  const toggle = () => {
    const next = dark ? 'light' : 'dark';
    setTheme(next);
    setPref(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'מעבר למצב תצוגה בהיר' : 'מעבר למצב תצוגה כהה'}
      className={`flex size-10 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-surface-hover ${className ?? ''}`}
      data-testid="theme-toggle"
      data-effective-theme={dark ? 'dark' : 'light'}
    >
      {dark ? <IconSun className="size-5" /> : <IconMoon className="size-5" />}
    </button>
  );
}
