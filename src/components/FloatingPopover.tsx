import { createPortal } from 'react-dom';
import { useLayoutEffect, useState, type CSSProperties, type Ref, type ReactNode, type RefObject } from 'react';

const VIEWPORT_PADDING = 14;

/**
 * Computes a fixed, viewport-clamped position for a popover anchored to a
 * trigger element, rendered through a portal so it can never be clipped by
 * an ancestor's overflow and never widens the document. Recomputed on open,
 * resize, and scroll. Aligns the popover's end edge (right, in RTL) with the
 * anchor's end edge, then clamps within VIEWPORT_PADDING of both screen
 * edges — the same logical alignment the old `start-0` CSS gave, but safe
 * near any screen edge instead of only working when there happened to be
 * room.
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
      const top = Math.min(rect.bottom + 6, vh - VIEWPORT_PADDING - 80);
      const effectiveMaxHeight = Math.max(160, Math.min(maxHeight, vh - top - VIEWPORT_PADDING));
      setStyle({
        position: 'fixed',
        top,
        left,
        width: effectiveWidth,
        maxHeight: effectiveMaxHeight,
        overflowY: 'auto',
      });
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
