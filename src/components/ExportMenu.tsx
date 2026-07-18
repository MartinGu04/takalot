import { useEffect, useRef, useState } from 'react';
import { IconChevronDown } from './icons';
import { FloatingPopover } from './FloatingPopover';

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
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

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

  return (
    <>
      <button
        ref={anchorRef}
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
      <FloatingPopover
        anchorRef={anchorRef}
        panelRef={panelRef}
        open={open}
        width={160}
        align="end"
        className="popover-panel z-50 animate-scale-in p-1.5"
      >
        <div role="menu" aria-label="אפשרויות ייצוא">
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
      </FloatingPopover>
    </>
  );
}
