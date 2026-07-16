import { useEffect, useRef, useState } from 'react';

/**
 * Local draft state for a text field whose committed value lives elsewhere
 * (e.g. URL-persisted filter state). Typing updates the local draft
 * instantly and synchronously — no external round-trip — and only commits
 * externally after `delayMs` of inactivity. This is what keeps a controlled
 * search/filter input from losing focus or dropping keystrokes: without it,
 * every keystroke pushes a new value through the URL and the query hook
 * immediately, and any resulting re-render/refetch that replaces the input's
 * subtree (e.g. a loading state) drops focus mid-word.
 *
 * External changes to `value` (browser back/forward, a "clear filters"
 * action, another filter control) are still respected: if the incoming
 * value doesn't match what this hook itself last committed, the draft
 * resyncs to it.
 */
export function useDebouncedField(
  value: string,
  onCommit: (next: string) => void,
  delayMs = 300,
): [string, (next: string) => void] {
  const [draft, setDraft] = useState(value);
  const lastCommitted = useRef(value);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (value !== lastCommitted.current) {
      setDraft(value);
      lastCommitted.current = value;
    }
  }, [value]);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const onChange = (next: string) => {
    setDraft(next);
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      lastCommitted.current = next;
      onCommitRef.current(next);
    }, delayMs);
  };

  return [draft, onChange];
}
