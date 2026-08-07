import { useEffect, useState } from 'react';

/** Debounces an already-local value (no external commit target -- contrast
 *  with useDebouncedField, which resyncs against an externally-committed
 *  value such as a URL param). Used to delay a server round-trip (a
 *  similarity lookup, a relation search) until the caller pauses typing,
 *  without delaying the input field itself, which stays fully responsive. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
