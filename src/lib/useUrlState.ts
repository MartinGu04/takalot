// Minimal URL-persisted state helper for filters (no external deps).
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

export function useUrlState() {
  const [params, setParams] = useSearchParams();

  const get = useCallback((key: string): string | undefined => params.get(key) ?? undefined, [params]);
  const getList = useCallback(
    (key: string): string[] => (params.get(key) ? params.get(key)!.split(',').filter(Boolean) : []),
    [params],
  );

  const applyToParams = (target: URLSearchParams, key: string, value: string | string[] | undefined) => {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      target.delete(key);
    } else {
      target.set(key, Array.isArray(value) ? value.join(',') : value);
    }
  };

  const set = useCallback(
    (key: string, value: string | string[] | undefined) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          applyToParams(next, key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  /**
   * Apply several key changes in a single history update. Calling `set()`
   * multiple times in one handler is unsafe: each call reads the same
   * not-yet-committed `prev` snapshot, so only the last `set()` call's diff
   * survives and every earlier change in that handler is silently discarded.
   * Use `setMany` whenever more than one filter key changes together.
   */
  const setMany = useCallback(
    (updates: Record<string, string | string[] | undefined>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(updates)) {
            applyToParams(next, key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const clear = useCallback(() => setParams({}, { replace: true }), [setParams]);

  return useMemo(
    () => ({ get, getList, set, setMany, clear, params }),
    [get, getList, set, setMany, clear, params],
  );
}
