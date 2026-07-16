import { useEffect, useRef, useState } from 'react';
import { IconChevronDown } from './icons';

export interface ExportOption {
  kind: string;
  label: string;
}

/** Single "ייצוא" trigger with a popover of format options, replacing separate per-format buttons. */
export function ExportMenu({
  options,
  onExport,
  disabled,
}: {
  options: ExportOption[];
  onExport: (kind: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-hairline-strong bg-surface px-4 py-2 text-sm font-medium text-text-primary shadow-soft hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        ייצוא
        <IconChevronDown className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="menu" aria-label="אפשרויות ייצוא" className="popover-panel absolute end-0 z-50 mt-1 w-40 animate-scale-in p-1.5">
          {options.map((opt) => (
            <button
              key={opt.kind}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onExport(opt.kind);
              }}
              className="flex w-full items-center rounded-lg px-2.5 py-2 text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
