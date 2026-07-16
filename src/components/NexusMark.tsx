// The Nexus glyph: an "N" built from three strokes with a small node at the
// crossing point, hinting at "a point of connection" rather than a plain
// letterform. Deliberately simple so it holds up at 20px in the sidebar and
// as a large, near-invisible watermark.
export function NexusGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M6.5 17.5V6.5M6.5 6.5l11 11M17.5 17.5V6.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Rounded-square brand mark for sidebar/header/login usage. */
export function NexusMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-[0_4px_14px_-2px] shadow-brand-600/50 ${className ?? ''}`}
    >
      <NexusGlyph className="h-[58%] w-[58%]" />
    </span>
  );
}
