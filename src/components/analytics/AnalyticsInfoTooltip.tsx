// Compact "מידע נוסף" (ⓘ) explanation trigger for the ניתוחים (analytics)
// page -- used sparingly, only where a metric genuinely benefits from a
// short plain-language explanation (median vs. average, a module that
// ignores the period filter). Built on FloatingPopover (the same portal/
// viewport-clamping engine ActionMenu/NotificationsMenu already use), NOT
// TruncatedTooltip: that component's reveal is hover/focus-only by design
// (effectively desktop-only), which cannot serve a mobile tap. Here, onClick
// toggles open -- works identically for touch and desktop mouse clicks, via
// a native <button> -- and onFocus separately opens it for a pure keyboard
// tab-in; outside-click, Escape, and blur close it. Deliberately no
// onMouseEnter hover-reveal: a real (and every simulated) mouse click is
// itself preceded by the pointer entering/hovering the element, so a hover-
// open would fire moments before the click's own toggle and immediately
// cancel it (hover opens -> click "toggles" what it doesn't know is already
// open -> closes). Click and keyboard-focus alone already cover touch,
// mouse, and keyboard use fully. A permanently-mounted sr-only <span>
// carries the explanation unconditionally (not gated on the visual open
// state), so a screen reader gets it regardless -- FloatingPopover only
// controls the sighted affordance.
import { useEffect, useId, useRef, useState } from 'react';
import { IconInfo } from '../icons';
import { FloatingPopover } from '../FloatingPopover';

export function AnalyticsInfoTooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const descId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // A mouse click also fires a `focus` event on the trigger just before
  // `click` -- without this flag, onFocus's setOpen(true) and onClick's
  // toggle would both queue in the same React batch, and the toggle
  // (reading the just-queued `true`) would immediately flip it back to
  // `false`, silently canceling the click. Set on mousedown, consumed (and
  // reset) by the very next focus event, so onFocus only ever auto-opens
  // for a real keyboard tab-in, never as a side effect of a click.
  const suppressNextFocusOpen = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-label="מידע נוסף"
        aria-describedby={descId}
        aria-expanded={open}
        onMouseDown={() => {
          suppressNextFocusOpen.current = true;
        }}
        onClick={() => setOpen((o) => !o)}
        onFocus={() => {
          if (suppressNextFocusOpen.current) {
            suppressNextFocusOpen.current = false;
            return;
          }
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        className="flex size-4.5 shrink-0 items-center justify-center rounded-full text-text-muted hover:text-text-secondary"
      >
        <IconInfo className="size-4" />
      </button>
      {/* Unconditional, sr-only -- reachable regardless of visual open state. */}
      <span id={descId} className="sr-only">
        {text}
      </span>
      <FloatingPopover
        anchorRef={triggerRef}
        panelRef={panelRef}
        open={open}
        width={260}
        align="end"
        className="popover-panel z-50 animate-scale-in p-3 text-sm leading-relaxed text-text-secondary"
      >
        <span aria-hidden="true">{text}</span>
      </FloatingPopover>
    </span>
  );
}
