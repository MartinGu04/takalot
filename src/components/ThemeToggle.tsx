import { useEffect, useRef, useState } from 'react';
import { getStoredTheme, isEffectivelyDark, setTheme, systemPrefersDark, type ThemePreference } from '../lib/theme';
import { IconCheck, IconMonitor, IconMoon, IconSun } from './icons';

const OPTIONS: { value: ThemePreference; label: string; icon: (p: { className?: string }) => React.ReactNode }[] = [
  { value: 'light', label: 'בהיר', icon: (p) => <IconSun {...p} /> },
  { value: 'dark', label: 'כהה', icon: (p) => <IconMoon {...p} /> },
  { value: null, label: 'אוטומטי (לפי המערכת)', icon: (p) => <IconMonitor {...p} /> },
];

/** Compact sun/moon display-mode control with a small popover for the auto option. */
export function ThemeToggle({ className }: { className?: string }) {
  const [pref, setPref] = useState<ThemePreference>(() => getStoredTheme());
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const dark = isEffectivelyDark(pref);
  const stateLabel = pref === 'light' ? 'בהיר' : pref === 'dark' ? 'כהה' : `אוטומטי — ${systemDark ? 'כהה' : 'בהיר'} כרגע`;

  const choose = (value: ThemePreference) => {
    setTheme(value);
    setPref(value);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`מצב תצוגה: ${stateLabel}. לחיצה לפתיחת אפשרויות תצוגה`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex size-10 items-center justify-center rounded-lg text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 ${className ?? ''}`}
        data-testid="theme-toggle"
      >
        {dark ? <IconMoon className="size-5" /> : <IconSun className="size-5" />}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="בחירת מצב תצוגה"
          className="absolute start-0 z-50 mt-1 w-44 animate-scale-in rounded-xl border border-neutral-200 bg-white p-1.5 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          {OPTIONS.map((opt) => {
            const selected = pref === opt.value;
            return (
              <button
                key={opt.label}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => choose(opt.value)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm ${
                  selected
                    ? 'bg-brand-50 font-medium text-brand-800 dark:bg-brand-950 dark:text-brand-200'
                    : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800'
                }`}
              >
                {opt.icon({ className: 'size-4 shrink-0' })}
                <span className="flex-1 text-right">{opt.label}</span>
                {selected && <IconCheck className="size-4 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
