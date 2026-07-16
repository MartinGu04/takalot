// Persist unfinished form content locally as a draft; warn before abandoning a dirty form.
import { useEffect, useRef } from 'react';

export function useDraft<T>(key: string, value: T, dirty: boolean) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (dirty) localStorage.setItem(key, JSON.stringify(value));
  }, [key, value, dirty]);
}

export function loadDraft<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function clearDraft(key: string): void {
  localStorage.removeItem(key);
}

/** Warn before navigating away / closing the tab while the form is dirty. */
export function useWarnOnUnload(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
