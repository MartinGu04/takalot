import { createPortal } from 'react-dom';
import { useLayoutEffect, useState, type CSSProperties, type Ref, type ReactNode, type RefObject } from 'react';

const VIEWPORT_PADDING = 14;

const GAP = 6;
// Below this, opening downward is considered too cramped to bother with --
// flip upward instead as long as there's actually more room that way.
const MIN_COMFORTABLE_HEIGHT = 160;

/**
 * Computes a fixed, viewport-clamped position for a popover anchored to a
 * trigger element, rendered through a portal so it can never be clipped by
 * an ancestor's overflow and never widens the document. Recomputed on open,
 * resize, and scroll. Aligns the popover's end edge (right, in RTL) with the
 * anchor's end edge, then clamps within VIEWPORT_PADDING of both screen
 * edges — the same logical alignment the old `start-0` CSS gave, but safe
 * near any screen edge instead of only working when there happened to be
 * room.
 *
 * Vertically it prefers opening downward, but flips upward (anchoring the
 * panel's bottom edge just above the trigger instead of its top edge just
 * below) when the trigger sits close enough to the bottom of the viewport
 * that opening down would be cramped and there's more room above -- e.g. a
 * row near the end of a list, just above a mobile bottom nav. Either way,
 * `maxHeight` is capped to whatever space that direction actually has, so
 * the panel itself (not just its scrollable content) can never cross the
 * opposite viewport edge.
 */
function usePopoverStyle(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  {
    width = 320,
    maxHeight = 420,
    align = 'start',
  }: { width?: number; maxHeight?: number; align?: 'start' | 'end' } = {},
): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      setStyle(null);
      return;
    }
    const compute = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const effectiveWidth = Math.min(width, vw - VIEWPORT_PADDING * 2);
      // RTL logical alignment: 'start' pins the panel's right edge to the
      // anchor's right edge (extends left); 'end' pins the panel's left edge
      // to the anchor's left edge (extends right) — mirrors what `start-0`/
      // `end-0` meant when this was plain absolutely-positioned CSS.
      let left = align === 'start' ? rect.right - effectiveWidth : rect.left;
      left = Math.max(VIEWPORT_PADDING, Math.min(left, vw - VIEWPORT_PADDING - effectiveWidth));

      const spaceBelow = vh - rect.bottom - GAP - VIEWPORT_PADDING;
      const spaceAbove = rect.top - GAP - VIEWPORT_PADDING;
      const opensUp = spaceBelow < MIN_COMFORTABLE_HEIGHT && spaceAbove > spaceBelow;
      // Capped to the space actually available in the chosen direction --
      // never to a fixed floor, which is what previously let the panel
      // extend past the viewport edge whenever a trigger sat close to it.
      const effectiveMaxHeight = Math.max(0, Math.min(maxHeight, opensUp ? spaceAbove : spaceBelow));

      setStyle(
        opensUp
          ? {
              position: 'fixed',
              bottom: vh - rect.top + GAP,
              left,
              width: effectiveWidth,
              maxHeight: effectiveMaxHeight,
              overflowY: 'auto',
            }
          : {
              position: 'fixed',
              top: rect.bottom + GAP,
              left,
              width: effectiveWidth,
              maxHeight: effectiveMaxHeight,
              overflowY: 'auto',
            },
      );
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open, anchorRef, width, maxHeight, align]);

  return style;
}

/**
 * Portal-rendered popover panel, positioned relative to `anchorRef` and
 * clamped to stay fully inside the viewport. Use in place of an
 * absolutely-positioned `<div>` under the trigger for any popover that can
 * appear near a screen edge (the previous approach clipped or overflowed
 * the document there).
 */
export function FloatingPopover({
  anchorRef,
  panelRef,
  open,
  width,
  maxHeight,
  align,
  className,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  /** Ref attached to the portaled panel — pass this to your outside-click check too, since a
   *  portaled panel is no longer inside the trigger's own wrapper element in the DOM tree. */
  panelRef?: Ref<HTMLDivElement>;
  open: boolean;
  width?: number;
  maxHeight?: number;
  /** RTL logical alignment against the anchor: 'start' (right-aligned, default) or 'end' (left-aligned). */
  align?: 'start' | 'end';
  className?: string;
  children: ReactNode;
}) {
  const style = usePopoverStyle(anchorRef, open, { width, maxHeight, align });
  if (!open || !style) return null;
  return createPortal(
    <div ref={panelRef} style={style} className={className}>
      {children}
    </div>,
    document.body,
  );
}
