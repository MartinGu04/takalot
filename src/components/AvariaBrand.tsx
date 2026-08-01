import { APP_NAME, APP_TAGLINE } from '../domain/labels';
import { IconAlertTriangle, IconClock } from './icons';

export const AVARIA_FULL_LOGO_SRC = '/branding/avaria-logo-full.png';
/** The approved symbol, kept byte-for-byte as supplied -- not rendered
 *  directly anywhere (its generous transparent safe-area makes it
 *  unsuitable for small chrome), but preserved as the canonical brand
 *  asset. */
export const AVARIA_ICON_SRC = '/branding/avaria-symbol.png';
/** A technical derivative of the symbol for small surfaces (header,
 *  sidebar, favicons): only the practically-transparent outer margin is
 *  trimmed (a bounding-box crop around the visible mark), so it fills the
 *  compact surface instead of sitting tiny in a mostly-empty square.
 *  Nothing inside the artwork's visible extent is cropped, redrawn,
 *  recolored, or distorted. */
export const AVARIA_ICON_COMPACT_SRC = '/branding/avaria-symbol-compact.png';

/** No default width/height utilities here on purpose: callers set the full
 * sizing themselves (this component has exactly one call site, which needs
 * different width AND height rules per breakpoint) so there is never a
 * same-property class collision to fight with. */
export function AvariaFullLogo({
  className,
  alt = APP_NAME,
}: {
  className?: string;
  alt?: string;
}) {
  return <img src={AVARIA_FULL_LOGO_SRC} alt={alt} className={`block object-contain ${className ?? ''}`} />;
}

/** Compact brand treatment for the authenticated shell (header/sidebar). A
 * restrained brand-tinted (violet, never flat neutral black) surface with a
 * visible border and soft brand-colored contact shadow in light mode, and a
 * softer dark-native border/shadow in dark mode -- a deliberate branded chip
 * in both themes, not an isolated black block. A CSS treatment only; the
 * flat solid-color mark itself needs no glow to stay legible on it. */
export function AvariaIcon({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-brand-300 bg-gradient-to-br from-brand-950 to-brand-800 p-1 shadow-[0_2px_8px_-2px_rgba(124,58,237,0.5)] dark:border-white/15 dark:shadow-[0_2px_8px_-2px_rgba(0,0,0,0.6)] ${className ?? ''}`}
    >
      <img src={AVARIA_ICON_COMPACT_SRC} alt="" className="size-full object-contain" />
    </span>
  );
}

/** Shared presentation zone for login and full-screen authentication states:
 * a fixed dark/purple brand moment (independent of the app's light/dark
 * toggle, matching the approved visual language) with the full logo as the
 * central element. Decorative atmosphere (glow, dot grid, floating status
 * chips) is pure CSS -- the supplied logo asset is never edited. */
export function AvariaAuthBrandPanel({
  titleTestId,
  compact = false,
  animate = false,
}: {
  titleTestId?: string;
  compact?: boolean;
  /** One-time entrance fade/settle for the login screen only (never the
   * shared loading/unauthorized/error auth screens). */
  animate?: boolean;
}) {
  return (
    <section
      className={`relative isolate flex overflow-hidden bg-[#0c0918] ${
        compact ? 'min-h-44 p-6 sm:p-8 lg:min-h-full' : 'h-[180px] px-6 py-4 lg:h-auto lg:min-h-full lg:p-12'
      }`}
      aria-label="AVARIA"
    >
      {/* Atmosphere stays restrained on mobile (one small soft glow, no
          grid/band) so the hero reads as part of one continuous surface
          with the auth content below it, not a separate boxed panel; the
          fuller decoration only earns its keep once the lg split gives it
          real room. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-16 -right-10 size-40 rounded-full bg-brand-600/20 blur-2xl lg:-top-32 lg:-right-20 lg:size-96 lg:bg-brand-600/25 lg:blur-3xl" />
        <div className="absolute -bottom-40 -left-24 hidden size-96 rounded-full bg-brand-900/40 blur-3xl lg:block" />
        <div
          className="absolute inset-0 hidden opacity-[0.12] lg:block"
          style={{
            backgroundImage: 'radial-gradient(rgba(216,203,255,0.7) 1px, transparent 1px)',
            backgroundSize: '22px 22px',
          }}
        />
        <div className="absolute inset-x-0 bottom-0 hidden h-1/2 bg-gradient-to-t from-brand-950/60 to-transparent lg:block" />
      </div>

      {!compact && (
        <>
          <div
            aria-hidden
            className="absolute end-6 top-6 hidden items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 backdrop-blur-sm lg:flex"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-500/20 text-brand-200">
              <IconAlertTriangle className="size-4" />
            </span>
            <span className="text-xs">
              <span className="block font-semibold text-white/90">זיהוי תקלה</span>
              <span className="mt-0.5 flex items-center gap-1 text-white/50">
                <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" />
                מערכת פעילה
              </span>
            </span>
          </div>
          <div
            aria-hidden
            className="absolute bottom-8 start-6 hidden w-40 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 backdrop-blur-sm lg:flex"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-500/20 text-brand-200">
              <IconClock className="size-4" />
            </span>
            <span className="min-w-0 flex-1 text-xs">
              <span className="block truncate font-semibold text-white/90">מעקב בזמן אמת</span>
              <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-white/10">
                <span className="block h-full w-2/3 rounded-full bg-brand-400/80" />
              </span>
            </span>
          </div>
        </>
      )}

      <div
        className={`relative z-10 m-auto w-full max-w-xl text-center ${
          animate ? '[animation:login-entrance_380ms_ease-out_80ms_both]' : ''
        }`}
      >
        <h1 data-testid={titleTestId}>
          <AvariaFullLogo className="mx-auto h-12 w-auto sm:h-14 lg:h-auto lg:w-full lg:max-w-sm" />
        </h1>
        <span aria-hidden className="mx-auto mt-2 block h-0.5 w-8 rounded-full bg-brand-500 lg:mt-4 lg:w-12" />
        <p className="mt-2 text-xs font-medium tracking-wide text-white/50 sm:text-sm lg:mt-4 lg:text-base lg:text-white/60">
          {APP_TAGLINE}
        </p>
      </div>
    </section>
  );
}
