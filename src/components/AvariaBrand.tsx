import { APP_NAME, APP_TAGLINE } from '../domain/labels';

export const AVARIA_FULL_LOGO_SRC = '/branding/avaria-logo-full.png';
export const AVARIA_ICON_SRC = '/branding/avaria-icon-512.png';

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

/** Compact brand treatment for the authenticated shell. The transparent
 * canonical icon remains unchanged; dark mode adds contrast behind it. */
export function AvariaIcon({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-transparent dark:bg-[#f1efe9] ${className ?? ''}`}
    >
      <img src={AVARIA_ICON_SRC} alt="" className="size-full object-contain" />
    </span>
  );
}

/** Shared presentation zone for login and full-screen authentication states. */
export function AvariaAuthBrandPanel({
  titleTestId,
  compact = false,
}: {
  titleTestId?: string;
  compact?: boolean;
}) {
  return (
    <section
      className={`relative isolate flex overflow-hidden bg-[#0d101a] ${
        compact ? 'min-h-44 p-6 sm:p-8 lg:min-h-full' : 'min-h-56 p-6 sm:p-10 lg:min-h-full lg:p-12'
      }`}
      aria-label="AVARIA"
    >
      <div
        aria-hidden
        className="absolute -top-32 -right-24 size-80 rounded-full bg-brand-700/20 blur-3xl"
      />
      <div
        aria-hidden
        className="absolute -bottom-36 -left-24 size-80 rounded-full bg-brand-950/50 blur-3xl"
      />
      <div className="relative z-10 m-auto w-full max-w-xl text-center">
        <h1
          className="rounded-2xl border border-white/70 bg-[#f1efe9] px-5 py-5 shadow-[0_20px_60px_-25px_rgba(0,0,0,0.75)] sm:px-8 sm:py-7"
          data-testid={titleTestId}
        >
          <AvariaFullLogo className="mx-auto w-full" />
        </h1>
        <p className="mt-5 text-sm font-medium tracking-wide text-slate-300 sm:text-base">{APP_TAGLINE}</p>
      </div>
    </section>
  );
}
