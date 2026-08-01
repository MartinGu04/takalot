// Department (unit) branding logos in the desktop header -- see Layout.tsx.
// Genuine responsive visibility, centered-clock, and no-overflow behavior
// need a real browser layout and are covered in e2e (34-department-logos.spec.ts);
// this file covers the static structure: exact canonical paths, the
// circular-crop technique, and decorative/non-interactive treatment.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DepartmentLogos, DEPARTMENT_LOGOS } from './DepartmentLogos';

describe('DepartmentLogos', () => {
  it('renders both department logos at their exact canonical asset paths', () => {
    render(<DepartmentLogos />);
    const container = screen.getByTestId('department-logos');
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    expect(Array.from(imgs).map((img) => img.getAttribute('src'))).toEqual([
      '/branding/departments/department-logo-502.jpg',
      '/branding/departments/department-logo-strategic-communication.jpg',
    ]);
    // Matches the canonical constant a future PDF export is expected to reuse.
    expect(DEPARTMENT_LOGOS.map((l) => l.src)).toEqual([
      '/branding/departments/department-logo-502.jpg',
      '/branding/departments/department-logo-strategic-communication.jpg',
    ]);
  });

  it('crops each logo to a circle (border-radius: 50%, overflow: hidden) without stretching the source image', () => {
    render(<DepartmentLogos />);
    const logo502 = screen.getByTestId('department-logo-502');
    const logoComms = screen.getByTestId('department-logo-strategic-communication');

    for (const circle of [logo502, logoComms]) {
      expect(circle).toHaveStyle({ borderRadius: '50%', overflow: 'hidden' });
      // Fixed square box -- a circle, not an oval -- at the requested ~30-34px size.
      expect(circle.className).toMatch(/size-8/);
    }

    // object-contain (not cover/fill) preserves the source aspect ratio and
    // never stretches or distorts the artwork.
    for (const img of Array.from(document.querySelectorAll('img'))) {
      expect(img.className).toMatch(/object-contain/);
    }
  });

  it('is purely decorative: not a link/button, not focusable, and hidden from assistive tech', () => {
    render(<DepartmentLogos />);
    const container = screen.getByTestId('department-logos');

    expect(container).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('a, button')).toBeNull();
    for (const img of Array.from(container.querySelectorAll('img'))) {
      expect(img).toHaveAttribute('alt', '');
      expect(img).not.toHaveAttribute('tabindex');
      expect(img.onclick).toBeNull();
    }
  });

  it('is a desktop/tablet-only element via the existing md: breakpoint, not JavaScript viewport detection', () => {
    render(<DepartmentLogos />);
    const container = screen.getByTestId('department-logos');
    // hidden by default (mobile), md:flex switches it on -- the exact same
    // breakpoint the mobile brand link / mobile user menu already use to
    // distinguish "mobile" from "desktop" in this header.
    expect(container.className).toMatch(/\bhidden\b/);
    expect(container.className).toMatch(/\bmd:flex\b/);
  });
});
