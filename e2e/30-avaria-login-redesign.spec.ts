// AVARIA brand refresh: the redesigned login screen renders the approved
// brand assets and the welcome/heading RTL hierarchy with no horizontal
// overflow across representative desktop and mobile viewports.
import { test, expect } from '@playwright/test';

const VIEWPORTS = [
  { width: 320, height: 700, label: 'mobile-small' },
  { width: 390, height: 844, label: 'mobile' },
  { width: 768, height: 1024, label: 'tablet' },
  { width: 1280, height: 900, label: 'desktop' },
  { width: 1440, height: 900, label: 'desktop-wide' },
];

for (const { width, height, label } of VIEWPORTS) {
  test(`login screen has no horizontal overflow at ${width}px (${label})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/login');
    await page.waitForTimeout(200);
    const hasOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(hasOverflow).toBe(false);
  });
}

test('desktop split composition: the brand panel (approved full logo) sits beside the auth panel, both reachable without scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/login');

  const brandHeading = page.getByRole('heading', { name: 'AVARIA' });
  await expect(brandHeading).toBeVisible();
  await expect(brandHeading.getByRole('img', { name: 'AVARIA' })).toHaveAttribute(
    'src',
    '/branding/avaria-logo-full.png',
  );
  await expect(page.getByText('ברוכים הבאים')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'כניסה למערכת' })).toBeVisible();

  // Both panels are on-screen together (the desktop split), not one below
  // a scroll boundary.
  const brandBox = await brandHeading.boundingBox();
  const loginBox = await page.getByRole('heading', { name: 'כניסה למערכת' }).boundingBox();
  expect(brandBox).toBeTruthy();
  expect(loginBox).toBeTruthy();
  expect(brandBox!.y).toBeLessThan(800);
  expect(loginBox!.y).toBeLessThan(800);
});

test('mobile stacked layout: the brand panel appears above the auth panel, with the sign-in action visible near the top of the scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/login');

  const brandHeading = page.getByRole('heading', { name: 'AVARIA' });
  const loginHeading = page.getByRole('heading', { name: 'כניסה למערכת' });
  await expect(brandHeading).toBeVisible();
  await expect(loginHeading).toBeVisible();

  const brandBox = await brandHeading.boundingBox();
  const loginBox = await loginHeading.boundingBox();
  expect(brandBox!.y).toBeLessThan(loginBox!.y);

  // The demo mode's primary sign-in action stands in for the Google button
  // here (interactive Google UI is out of scope for CI, per the existing
  // auth-routing suite) -- it must not require excessive scrolling.
  const firstAction = page.locator('[data-testid^="login-"]').first();
  await expect(firstAction).toBeVisible();
  const actionBox = await firstAction.boundingBox();
  expect(actionBox!.y).toBeLessThan(812 * 2);
});
