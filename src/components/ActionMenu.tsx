// Compact "three dots" overflow menu for per-row actions.
//
// Row-level actions (edit, delete) are collapsed behind a single trigger so a
// long list stays scannable, without the actions becoming pointer-only: the
// menu implements the keyboard contract a `role="menu"` is expected to honor
// -- open from the trigger, arrow/Home/End roving focus, Escape to dismiss
// with focus returned to the trigger, and outside-click dismissal.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { IconDotsVertical } from './icons';

export interface ActionMenuItem {
  label: string;
  onSelect: () => void;
  /** Renders in the destructive tone and below a separator. */
  destructive?: boolean;
  disabled?: boolean;
  /** Explanation shown when the item is disabled. */
  title?: string;
}

export function ActionMenu({ label, items }: { label: string; items: ActionMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<'first' | 'last'>('first');

  // Only enabled items take part in roving focus -- a disabled item stays
  // rendered (its title explains why it is unavailable) but is never a
  // keyboard stop, matching how the rest of the app treats blocked actions.
  const focusableItems = () =>
    Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [],
    );

  const closeAndFocusTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const openMenu = (focus: 'first' | 'last') => {
    focusOnOpen.current = focus;
    setOpen(true);
  };

  const selectAction = (item: ActionMenuItem) => {
    if (item.disabled) return;
    setOpen(false);
    triggerRef.current?.focus();
    item.onSelect();
  };

  useEffect(() => {
    if (!open) return;
    // Deferred a tick so the panel is mounted before focus moves into it.
    const timer = window.setTimeout(() => {
      const focusable = focusableItems();
      (focusOnOpen.current === 'last' ? focusable.at(-1) : focusable[0])?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAndFocusTrigger();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      // Tab leaves the menu rather than cycling inside it: this is a menu,
      // not a modal, so it must never trap focus on the page.
      setOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const focusable = focusableItems();
    if (focusable.length === 0) return;
    event.preventDefault();
    const currentIndex = focusable.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Home') {
      focusable[0].focus();
    } else if (event.key === 'End') {
      focusable.at(-1)?.focus();
    } else {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex =
        currentIndex === -1 ? 0 : (currentIndex + step + focusable.length) % focusable.length;
      focusable[nextIndex].focus();
    }
  };

  if (items.length === 0) return null;

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        onClick={() => (open ? setOpen(false) : openMenu('first'))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu(event.key === 'ArrowUp' ? 'last' : 'first');
          }
        }}
        className="flex size-9 items-center justify-center rounded-lg text-text-muted hover:bg-surface-hover hover:text-text-primary"
      >
        <IconDotsVertical className="size-4.5" />
      </button>
      {open && (
        <div
          ref={panelRef}
          className="popover-panel absolute end-0 top-full z-50 mt-1 w-max min-w-40 animate-scale-in p-1.5"
        >
          <div id={menuId} role="menu" aria-label={label} onKeyDown={handleMenuKeyDown}>
            {items.map((item, index) => {
              // The destructive action is both toned and separated: a rule
              // above it makes an accidental activation take a deliberate
              // extra step of travel, not just a colour change.
              const separated = item.destructive && index > 0;
              return (
                <div key={item.label} className={separated ? 'mt-1 border-t border-hairline pt-1' : undefined}>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    disabled={item.disabled}
                    title={item.title}
                    onClick={() => selectAction(item)}
                    className={`flex min-h-10 w-full items-center rounded-lg px-3 py-2 text-start text-sm disabled:cursor-not-allowed disabled:opacity-50 ${
                      item.destructive
                        ? 'font-medium text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/50'
                        : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                    }`}
                  >
                    {item.label}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
