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

/**
 * Clears the draft when the user genuinely navigates away from `routePath`
 * to a different route -- leaving the create form counts as abandoning it,
 * so the next visit must start clean rather than restoring stale content.
 *
 * Only acts on a REAL navigation-away, not on:
 * - ordinary re-renders or query refetches (this only runs its cleanup on
 *   unmount, never on a re-render of the same mounted instance);
 * - React StrictMode's development-only mount -> cleanup -> mount cycle,
 *   which unmounts and remounts synchronously without the URL ever
 *   changing. The distinguishing check is the actual browser pathname at
 *   cleanup time: a StrictMode phantom unmount still shows `routePath`
 *   (nothing navigated), while a genuine navigation has already updated
 *   `window.location.pathname` to the new route by the time this cleanup
 *   fires (React Router updates the URL before unmounting the old route's
 *   component tree).
 */
export function useClearDraftOnRouteLeave(key: string, routePath: string): void {
  useEffect(() => {
    return () => {
      if (window.location.pathname !== routePath) {
        clearDraft(key);
      }
    };
  }, [key, routePath]);
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
