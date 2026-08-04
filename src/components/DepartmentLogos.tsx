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

export function DepartmentLogos({
  className,
  badgeClassName,
}: { className?: string; badgeClassName?: string } = {}) {
  return (
    <div
      className={className ?? 'hidden shrink-0 items-center gap-1.5 md:flex'}
      aria-hidden="true"
      data-testid="department-logos"
    >
      {DEPARTMENT_LOGOS.map((logo) => (
        <span
          key={logo.key}
          data-testid={`department-logo-${logo.key}`}
          className={
            badgeClassName ??
            'flex size-10 shrink-0 items-center justify-center border border-hairline-strong bg-surface lg:size-[46px]'
          }
          // The circular crop must remove only the source image's square
          // black outer corners -- never any part of the emblem, ring, or
          // text -- so this is an explicit 50%/hidden crop, not a
          // pixel-radius approximation (rounded-full computes to a
          // different literal value).
          style={{ borderRadius: '50%', overflow: 'hidden' }}
        >
          {/* The badge is sized to read as a clearly visible, intentional
              mark in the header rather than a tiny dot, but the artwork
              itself should still show less unnecessary black margin than
              the source frame carries, so the image is deliberately sized a
              bit past its own circle (112%, same on both axes -- this
              scales the box the source image sits in, never the image
              file, and scaling both axes equally can never skew its aspect
              ratio) rather than filling it exactly. The parent's
              overflow:hidden + circular mask trims only the excess margin
              the source frame already carries around the mark, the same
              way it already trimmed the square corners, leaving a small
              even gap between the mark itself and the border on every
              side. object-contain still governs how the image box itself
              renders the source file, so it's still never stretched or
              cropped. */}
          <img
            src={logo.src}
            alt=""
            // max-w-none overrides Tailwind's preflight `img { max-width:
            // 100% }`, which would otherwise silently cap this at the
            // parent's width and defeat the 112% zoom below.
            className="h-[112%] w-[112%] max-w-none shrink-0 object-contain"
          />
        </span>
      ))}
    </div>
  );
}
