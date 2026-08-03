// A single "סינון לפי תאריך" trigger with a popover holding the from/to date
// range, replacing two permanently-visible date inputs in the archive's
// filter bar -- same trigger+FloatingPopover idiom as ExportMenu/
// NotificationsMenu (outside-click + Escape to dismiss, viewport-clamped so
// it never overflows on mobile).
import { useEffect, useRef, useState } from 'react';
import { FloatingPopover } from './FloatingPopover';
import { Button, Field, Input } from './ui';
import { IconCalendar } from './icons';
import { formatDate } from '../lib/time';

function summaryLabel(from: string | undefined, to: string | undefined): string {
  if (from && to) return `${formatDate(from)}–${formatDate(to)}`;
  if (from) return `מתאריך ${formatDate(from)}`;
  if (to) return `עד תאריך ${formatDate(to)}`;
  return 'סינון לפי תאריך';
}

export function ArchiveDateFilter({
  from,
  to,
  onApply,
  onClear,
}: {
  from: string | undefined;
  to: string | undefined;
  onApply: (from: string | undefined, to: string | undefined) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Local drafts, isolated from the applied from/to until "החל סינון" -- so
  // closing the panel (Escape, outside click, or the trigger itself) without
  // applying can never modify the active filter.
  const [fromDraft, setFromDraft] = useState(from ?? '');
  const [toDraft, setToDraft] = useState(to ?? '');
  const [error, setError] = useState<string | undefined>();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const active = Boolean(from || to);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!anchorRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
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

  const openPanel = () => {
    // Reopening always shows the currently applied values, not whatever was
    // left over in a draft from a previous open-then-cancel.
    setFromDraft(from ?? '');
    setToDraft(to ?? '');
    setError(undefined);
    setOpen(true);
  };

  const handleApply = () => {
    if (fromDraft && toDraft && fromDraft > toDraft) {
      setError('תאריך ההתחלה חייב להיות מוקדם מתאריך הסיום.');
      return;
    }
    setError(undefined);
    onApply(fromDraft || undefined, toDraft || undefined);
    setOpen(false);
  };

  const handleClear = () => {
    setFromDraft('');
    setToDraft('');
    setError(undefined);
    onClear();
    setOpen(false);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPanel())}
        className={`flex min-h-9 w-auto items-center gap-2 rounded-lg border px-2 py-1.5 text-sm font-medium transition-colors ${
          active
            ? 'border-brand-300 bg-brand-50 text-brand-900 hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950/50 dark:text-brand-200 dark:hover:bg-brand-900/60'
            : 'border-hairline-strong bg-surface text-text-primary hover:bg-surface-hover'
        }`}
      >
        <IconCalendar className="size-4.5 shrink-0" />
        {/* dir="ltr": the applied-range summary joins two dates with a dash
            (e.g. "01.06.2026–15.07.2026") -- inside the page's RTL base
            direction, the bidi algorithm treats that dash as a neutral
            character and reorders the whole pair backwards ("15.07.2026–
            01.06.2026", to before from). Forcing this span to ltr fixes the
            visual order without touching the underlying string (still
            from -> to for the accessible name) or the plain/one-sided label
            cases, which have no neutral-joined date pair to reorder. */}
        <span dir="ltr" className="min-w-0 flex-1 truncate text-right">{summaryLabel(from, to)}</span>
      </button>
      <FloatingPopover
        anchorRef={anchorRef}
        panelRef={panelRef}
        open={open}
        width={300}
        maxHeight={420}
        className="popover-panel z-50 animate-scale-in p-3.5"
      >
        <div role="group" aria-label="סינון לפי תאריך" className="flex flex-col gap-3">
          <Field label="מתאריך">
            {(a) => (
              <Input
                {...a}
                type="date"
                value={fromDraft}
                onChange={(e) => setFromDraft(e.target.value)}
              />
            )}
          </Field>
          <Field label="עד תאריך">
            {(a) => (
              <Input
                {...a}
                type="date"
                value={toDraft}
                onChange={(e) => setToDraft(e.target.value)}
              />
            )}
          </Field>
          {error && (
            <p role="alert" className="text-xs font-medium text-red-700 dark:text-red-400">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={handleClear}>נקה</Button>
            <Button type="button" variant="primary" onClick={handleApply}>החל סינון</Button>
          </div>
        </div>
      </FloatingPopover>
    </>
  );
}
