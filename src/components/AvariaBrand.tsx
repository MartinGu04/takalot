import { APP_NAME, APP_TAGLINE } from '../domain/labels';
import { DepartmentLogos } from './DepartmentLogos';

export const AVARIA_FULL_LOGO_SRC = '/branding/avaria-logo-full.png';
/** The approved symbol, kept byte-for-byte as supplied -- not rendered
 *  directly anywhere (its generous transparent safe-area makes it
 *  unsuitable for small chrome), but preserved as the canonical brand
 *  asset. */
export const AVARIA_ICON_SRC = '/branding/avaria-symbol.png';
/** A dedicated, approved compact asset for small product surfaces (header,
 *  sidebar, favicons): a self-contained white-on-purple rounded-square
 *  tile, already high-contrast and ready to use in both themes with no
 *  extra backing. Kept byte-for-byte as supplied everywhere except the
 *  favicon/apple-touch-icon files, which are plain resizes (no recolor,
 *  no recompression beyond what the target pixel size requires). */
export const AVARIA_ICON_COMPACT_SRC = '/branding/avaria-compact-micro-mark.png';

/** No default width/height/object-fit utilities here on purpose: callers set
 * all of that themselves (this component has two call sites -- a mobile
 * crop needing object-cover, a desktop one needing object-contain -- with
 * different width/height rules per breakpoint too), so there is never a
 * same-property class collision to fight with. */
export function AvariaFullLogo({
  className,
  alt = APP_NAME,
}: {
  className?: string;
  alt?: string;
}) {
  return <img src={AVARIA_FULL_LOGO_SRC} alt={alt} className={`block ${className ?? ''}`} />;
}

/** Compact brand treatment for the authenticated shell (header/sidebar).
 * The approved micro-mark already carries its own high-contrast
 * purple/white tile, so it's used identically in both themes with no
 * backing plate, border, or padding of ours layered on top. */
export function AvariaIcon({ className }: { className?: string }) {
  return (
    <img
      src={AVARIA_ICON_COMPACT_SRC}
      alt=""
      aria-hidden
      className={`block shrink-0 object-contain ${className ?? ''}`}
    />
  );
}

/** Full-bleed decorative backdrop for the V2 login/auth-splash experience:
 * layered dark navy/purple gradients, ambient glows, a faint dot grid, a
 * restrained waveform accent (echoing the AVARIA mark's own EKG motif), and
 * a handful of static/slow-drifting light points. Pure CSS, no canvas/particle
 * dependency. Meant as the first child of a `position: relative` full-viewport
 * wrapper so it paints edge-to-edge behind both the brand and login columns --
 * there is deliberately no per-column background, so the split never reads as
 * two separate boxed cards. Decorative only: aria-hidden and
 * pointer-events-none throughout, so it never intercepts input or gets
 * announced to assistive tech. Any animation here is covered by the app-wide
 * prefers-reduced-motion rule in index.css, which collapses it to static. */
export function AvariaLoginAtmosphere() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 85% 55% at 12% -5%, rgba(139,92,246,0.24), transparent 60%), ' +
            'radial-gradient(ellipse 65% 55% at 100% 105%, rgba(88,28,135,0.30), transparent 60%), ' +
            'linear-gradient(160deg, #05030c 0%, #0a0716 45%, #100a1f 100%)',
        }}
      />
      <div className="absolute -top-24 -right-16 size-[26rem] rounded-full bg-brand-600/20 blur-[110px] lg:size-[34rem]" />
      <div className="absolute -bottom-32 -left-20 size-[22rem] rounded-full bg-brand-900/50 blur-[100px] lg:size-[30rem]" />
      <div
        className="absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage: 'radial-gradient(rgba(216,203,255,0.9) 1px, transparent 1px)',
          backgroundSize: '26px 26px',
        }}
      />
      <svg
        className="absolute inset-x-0 bottom-[20%] w-full opacity-[0.09] lg:bottom-[14%]"
        viewBox="0 0 800 60"
        preserveAspectRatio="none"
        fill="none"
      >
        <path d="M0 30H130l22-24 24 46 22-34 18 12H800" stroke="#d8cbff" strokeWidth="1.4" />
      </svg>
      <span className="absolute left-[14%] top-[26%] size-1 rounded-full bg-brand-200/70 [animation:avaria-particle-drift_10s_ease-in-out_infinite]" />
      <span className="absolute left-[78%] top-[64%] size-1 rounded-full bg-brand-200/60 [animation:avaria-particle-drift_12s_ease-in-out_infinite_1.5s]" />
      <span className="absolute left-[45%] top-[12%] size-[3px] rounded-full bg-brand-100/50 [animation:avaria-particle-drift_14s_ease-in-out_infinite_3s]" />
      <span className="absolute left-[85%] top-[22%] size-[3px] rounded-full bg-brand-100/40" />
      <span className="absolute left-[8%] top-[72%] size-[3px] rounded-full bg-brand-100/40" />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/50 to-transparent" />
    </div>
  );
}

/** Shared presentation zone for login and full-screen authentication states.
 * `compact` (used only by the light-theme Shell in AuthScreens.tsx for the
 * unauthorized/error/config-error states) keeps its original small floating
 * dark card -- untouched by the V2 redesign below, which is scoped to the
 * login screen and its loading splash. The non-compact path renders content
 * only (no background of its own): it's meant to sit directly on a shared
 * `AvariaLoginAtmosphere`, so the page never reads as two separate cards. */
export function AvariaAuthBrandPanel({
  titleTestId,
  compact = false,
  animate = false,
  showDepartmentLogos = false,
}: {
  titleTestId?: string;
  compact?: boolean;
  /** One-time entrance fade/settle for the login screen only (never the
   * shared loading/unauthorized/error auth screens). */
  animate?: boolean;
  /** Adds the two approved unit logos as a restrained identity strip below
   * the tagline. Login screen only -- left off the loading splash and the
   * compact auth-state screens to keep them minimal. */
  showDepartmentLogos?: boolean;
}) {
  if (compact) {
    return (
      <section
        className="relative isolate flex min-h-44 overflow-hidden bg-[#0c0918] p-6 sm:p-8 lg:min-h-full"
        aria-label="AVARIA"
      >
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

        <div className="relative z-10 m-auto w-full max-w-xl text-center">
          <h1 data-testid={titleTestId}>
            <span className="relative mx-auto block aspect-[16/5] w-[83%] overflow-hidden rounded-2xl lg:aspect-auto lg:w-fit lg:overflow-visible lg:rounded-[2rem] lg:p-8">
              <span
                aria-hidden
                className="absolute inset-0"
                style={{
                  backgroundImage:
                    'radial-gradient(ellipse at center, rgba(6,3,14,0.7) 0%, rgba(6,3,14,0.32) 55%, rgba(6,3,14,0) 80%)',
                }}
              />
              <AvariaFullLogo className="relative h-full w-full object-cover lg:h-auto lg:w-auto lg:max-w-sm lg:object-contain" />
            </span>
          </h1>
          <span aria-hidden className="mx-auto mt-2 block h-0.5 w-8 rounded-full bg-brand-500 lg:mt-4 lg:w-12" />
          <p className="mt-2 text-xs font-medium tracking-wide text-white/50 sm:text-sm lg:mt-4 lg:text-base lg:text-white/60">
            {APP_TAGLINE}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="AVARIA"
      className="relative z-10 flex shrink-0 flex-col items-center justify-center gap-4 px-6 pt-10 pb-6 text-center sm:px-10 lg:w-[44%] lg:gap-7 lg:px-12 lg:py-14"
    >
      {/* The logo's flat purple reads weakly straight against the shared
          purple atmosphere, so a soft near-black ink pool sits behind it --
          CSS only, the asset itself is never recolored. This is a SINGLE
          image (one heading, one alt, one testid) whose sizing responds per
          breakpoint, deliberately not two conditionally hidden elements: a
          test environment without real CSS (jsdom) would otherwise see two
          simultaneously "visible" accessible images. Mobile crops to the
          wordmark's own band via object-cover on a wide aspect box (the
          canvas's huge transparent margin is never displayed); desktop shows
          the full canvas uncropped, large and prominent. */}
      <h1 data-testid={titleTestId} className={animate ? '[animation:login-entrance_380ms_ease-out_80ms_both]' : ''}>
        <span className="relative mx-auto block aspect-[16/5] w-[78%] max-w-xs overflow-hidden rounded-2xl sm:max-w-sm lg:aspect-auto lg:w-fit lg:max-w-none lg:overflow-visible">
          <span
            aria-hidden
            className="absolute inset-0"
            style={{
              backgroundImage:
                'radial-gradient(ellipse at center, rgba(6,3,14,0.55) 0%, rgba(6,3,14,0.24) 55%, rgba(6,3,14,0) 80%)',
            }}
          />
          <AvariaFullLogo className="relative h-full w-full object-cover lg:h-auto lg:w-auto lg:max-w-[560px] lg:object-contain" />
        </span>
      </h1>
      <span aria-hidden className="block h-0.5 w-10 rounded-full bg-brand-500 lg:w-14" />
      <p className="max-w-sm text-sm font-medium tracking-wide text-white/60 sm:text-base lg:text-lg">
        {APP_TAGLINE}
      </p>
      {showDepartmentLogos && (
        // Forces the app's dark surface/hairline tokens for this strip
        // regardless of the page's own (light-mode-default) theme, so the
        // badges read as intentional dark chrome against the navy backdrop
        // instead of a stray light rectangle -- the shared token system's
        // own `.dark` scope, not a one-off color.
        <div className="dark mt-1 hidden items-center gap-3 lg:flex">
          <DepartmentLogos className="flex shrink-0 items-center gap-2.5" />
        </div>
      )}
    </section>
  );
}
