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

  const set = useCallback(
    (key: string, value: string | string[] | undefined) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
            next.delete(key);
          } else {
            next.set(key, Array.isArray(value) ? value.join(',') : value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const clear = useCallback(() => setParams({}, { replace: true }), [setParams]);

  return useMemo(() => ({ get, getList, set, clear, params }), [get, getList, set, clear, params]);
}
