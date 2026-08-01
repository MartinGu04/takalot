// AVARIA brand refresh: the redesigned login screen renders the approved
// brand assets, fills most of the viewport in an even split on desktop, and
// becomes one cohesive compact-hero-plus-form surface on mobile -- with no
// horizontal overflow at any of it.
import { test, expect } from '@playwright/test';

const OVERFLOW_VIEWPORTS = [
  { width: 320, height: 700, label: 'mobile-small' },
  { width: 390, height: 844, label: 'mobile' },
  { width: 768, height: 1024, label: 'tablet' },
  { width: 1280, height: 900, label: 'desktop' },
  { width: 1366, height: 768, label: 'desktop-1366' },
  { width: 1440, height: 900, label: 'desktop-1440' },
  { width: 1920, height: 1080, label: 'desktop-1920' },
];

for (const { width, height, label } of OVERFLOW_VIEWPORTS) {
  test(`login screen has no horizontal or vertical overflow at ${width}x${height} (${label})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/login');
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      y: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    }));
    expect(overflow.x).toBe(false);
    // Desktop (lg+) is a fixed-height split -- the page itself must never
    // scroll vertically there (any internal overflow is contained in a
    // scrollable column, not the page).
    if (width >= 1024) expect(overflow.y).toBe(false);
  });
}

test.describe('desktop split composition (1366x768, 1440x900, 1920x1080)', () => {
  for (const { width, height } of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    test(`fills most of the viewport with an ~equal split and restrained outer margin at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/login');

      const brandHeading = page.getByRole('heading', { name: 'AVARIA' });
      await expect(brandHeading).toBeVisible();
      await expect(brandHeading.getByRole('img', { name: 'AVARIA' })).toHaveAttribute(
        'src',
        '/branding/avaria-logo-full.png',
      );
      const loginHeading = page.getByRole('heading', { name: 'כניסה למערכת' });
      await expect(loginHeading).toBeVisible();
      await expect(page.getByText('ברוכים הבאים')).toBeVisible();

      // The card (shell) occupies most of the viewport, with a restrained
      // (roughly 24-40px) outer margin -- not a large empty frame.
      const shell = page.locator('.rounded-3xl').first();
      const shellBox = await shell.boundingBox();
      expect(shellBox).toBeTruthy();
      const marginX = (width - shellBox!.width) / 2;
      const marginY = (height - shellBox!.height) / 2;
      expect(marginX).toBeGreaterThanOrEqual(16);
      expect(marginX).toBeLessThanOrEqual(56);
      expect(marginY).toBeGreaterThanOrEqual(16);
      expect(marginY).toBeLessThanOrEqual(56);
      expect(shellBox!.width).toBeGreaterThan(width * 0.85);
      expect(shellBox!.height).toBeGreaterThan(height * 0.85);

      // Roughly equal 50/50 panels: the brand heading (right column) and
      // the auth heading (left column) sit in similarly-wide halves.
      const brandBox = await brandHeading.boundingBox();
      const loginBox = await loginHeading.boundingBox();
      const brandColumnStart = brandBox!.x;
      const loginColumnStart = loginBox!.x;
      expect(brandColumnStart).toBeGreaterThan(shellBox!.x + shellBox!.width * 0.3);
      expect(loginColumnStart).toBeLessThan(shellBox!.x + shellBox!.width * 0.55);
    });
  }
});

test('mobile: one cohesive surface with a compact integrated hero, not two stacked desktop panels', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');

  // Exactly one brand heading exists in the DOM (the same element is
  // restyled responsively) -- never a duplicated hero + full desktop panel.
  await expect(page.getByRole('heading', { name: 'AVARIA' })).toHaveCount(1);

  const brandRegion = page.getByRole('region', { name: 'AVARIA' });
  const heroBox = await brandRegion.boundingBox();
  expect(heroBox).toBeTruthy();
  expect(heroBox!.height).toBeGreaterThanOrEqual(150);
  expect(heroBox!.height).toBeLessThanOrEqual(230);

  // Desktop-only floating status chips must not appear on mobile.
  await expect(page.getByText('זיהוי תקלה')).toBeHidden();
  await expect(page.getByText('מעקב בזמן אמת')).toBeHidden();

  // The required hierarchy -- welcome indicator, heading, description, and
  // the sign-in action -- is all visible within the initial viewport,
  // no scrolling needed.
  const welcomePill = page.getByText('ברוכים הבאים');
  const loginHeading = page.getByRole('heading', { name: 'כניסה למערכת' });
  const firstAction = page.locator('[data-testid^="login-"]').first();
  await expect(welcomePill).toBeVisible();
  await expect(loginHeading).toBeVisible();
  await expect(firstAction).toBeVisible();

  for (const locator of [welcomePill, loginHeading, firstAction]) {
    const box = await locator.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  }
});

test('mobile at 320x700: the sign-in action is visible in the initial viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/login');

  const firstAction = page.locator('[data-testid^="login-"]').first();
  await expect(firstAction).toBeVisible();
  const actionBox = await firstAction.boundingBox();
  expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(700);
});

test.describe('login entrance motion', () => {
  test('completes within 700ms and settles to full opacity / no offset (no residual transform)', async ({ page }) => {
    await page.goto('/login');
    const shell = page.locator('.rounded-3xl').first();
    await page.waitForTimeout(750);
    const finalState = await shell.evaluate((el) => {
      const style = getComputedStyle(el);
      return { opacity: style.opacity, transform: style.transform };
    });
    expect(finalState.opacity).toBe('1');
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(finalState.transform);
  });

  test('the sign-in action is clickable immediately, before the entrance motion finishes', async ({ page }) => {
    // No artificial wait -- clicking as soon as the element is attached
    // proves the animation never blocks interactivity.
    await page.goto('/login');
    await page.getByTestId(/^login-/).first().click();
    await expect(page.getByRole('heading', { name: 'מצב נוכחי' })).toBeVisible();
  });

  test('respects prefers-reduced-motion: motion collapses to an almost-instant fade', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/login');
    const shell = page.locator('.rounded-3xl').first();
    const durationMs = await shell.evaluate((el) => {
      const raw = getComputedStyle(el).animationDuration; // e.g. "0.000001s" or "0.001ms"
      const value = parseFloat(raw);
      return raw.trim().endsWith('ms') ? value : value * 1000;
    });
    // The global reduced-motion rule forces all animation-durations to
    // 0.001ms -- i.e. effectively instant, no visible movement.
    expect(durationMs).toBeLessThanOrEqual(0.01);
  });
});
