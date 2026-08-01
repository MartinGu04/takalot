// Department (unit) branding logos shown in the desktop/tablet header only
// (see Layout.tsx). The source images are the canonical assets under
// public/branding/departments/ -- a future PDF export reuses these exact
// files, so they must never be redrawn, recolored, or regenerated here.
// Purely decorative: never a link/button, and hidden from assistive tech
// (empty alt + aria-hidden) so screen readers aren't forced to announce
// redundant branding on every page.
export const DEPARTMENT_LOGOS = [
  { key: '502', src: '/branding/departments/department-logo-502.jpg' },
  {
    key: 'strategic-communication',
    src: '/branding/departments/department-logo-strategic-communication.jpg',
  },
] as const;

export function DepartmentLogos() {
  return (
    <div
      className="hidden shrink-0 items-center gap-1.5 md:flex"
      aria-hidden="true"
      data-testid="department-logos"
    >
      {DEPARTMENT_LOGOS.map((logo) => (
        <span
          key={logo.key}
          data-testid={`department-logo-${logo.key}`}
          className="flex size-8 shrink-0 items-center justify-center border border-hairline-strong bg-surface"
          // The circular crop must remove only the source image's square
          // black outer corners -- never any part of the emblem, ring, or
          // text -- so this is an explicit 50%/hidden crop, not a
          // pixel-radius approximation (rounded-full computes to a
          // different literal value).
          style={{ borderRadius: '50%', overflow: 'hidden' }}
        >
          {/* object-contain (not cover) always preserves the source aspect
              ratio and never stretches it; a square source image fills this
              square box exactly, so only its own black corners fall outside
              the circular mask above. */}
          <img src={logo.src} alt="" className="size-full object-contain" />
        </span>
      ))}
    </div>
  );
}
