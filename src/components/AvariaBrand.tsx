import { APP_NAME, APP_TAGLINE } from '../domain/labels';
import { IconAlertTriangle, IconClock } from './icons';

export const AVARIA_FULL_LOGO_SRC = '/branding/avaria-logo-full.png';
export const AVARIA_ICON_SRC = '/branding/avaria-symbol.png';

export function AvariaFullLogo({
  className,
  alt = APP_NAME,
}: {
  className?: string;
  alt?: string;
}) {
  return (
    <img
      src={AVARIA_FULL_LOGO_SRC}
      alt={alt}
      className={`block h-auto max-w-full object-contain ${className ?? ''}`}
    />
  );
}

/** Compact brand treatment for the authenticated shell (header/sidebar). The
 * approved symbol's glow/highlight artwork is designed for a dark backdrop,
 * so it sits on a small fixed-dark plate regardless of the app's light/dark
 * mode -- a CSS backing, never a modification of the asset itself. */
export function AvariaIcon({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#0d0a17] p-1 ${className ?? ''}`}
    >
      <img src={AVARIA_ICON_SRC} alt="" className="size-full object-contain" />
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
}: {
  titleTestId?: string;
  compact?: boolean;
}) {
  return (
    <section
      className={`relative isolate flex overflow-hidden bg-[#0a0716] ${
        compact ? 'min-h-44 p-6 sm:p-8 lg:min-h-full' : 'min-h-64 p-6 sm:p-10 lg:min-h-full lg:p-12'
      }`}
      aria-label="AVARIA"
    >
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-32 -right-20 size-96 rounded-full bg-brand-600/25 blur-3xl" />
        <div className="absolute -bottom-40 -left-24 size-96 rounded-full bg-brand-900/40 blur-3xl" />
        <div
          className="absolute inset-0 opacity-[0.12]"
          style={{
            backgroundImage: 'radial-gradient(rgba(216,203,255,0.7) 1px, transparent 1px)',
            backgroundSize: '22px 22px',
          }}
        />
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-brand-950/60 to-transparent" />
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

      <div className="relative z-10 m-auto w-full max-w-xl text-center">
        <h1 data-testid={titleTestId}>
          <AvariaFullLogo className="mx-auto w-full max-w-sm" />
        </h1>
        <span aria-hidden className="mx-auto mt-4 block h-0.5 w-12 rounded-full bg-brand-500" />
        <p className="mt-4 text-sm font-medium tracking-wide text-white/60 sm:text-base">{APP_TAGLINE}</p>
      </div>
    </section>
  );
}
