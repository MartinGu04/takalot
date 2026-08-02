// AVARIA branding, the desktop sidebar / mobile bottom nav split, and the
// compact display-mode control introduced in the branding & navigation PR.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test('AVARIA branding appears on the login screen with the canonical full logo', async ({ page }) => {
  await page.goto('/login');
  const brandHeading = page.getByRole('heading', { name: 'AVARIA' });
  await expect(brandHeading).toBeVisible();
  await expect(brandHeading.getByRole('img', { name: 'AVARIA' })).toHaveAttribute(
    'src',
    '/branding/avaria-logo-full.png',
  );
  await expect(
    page.getByRole('region', { name: 'AVARIA' }).getByText('מערכת ניהול ומעקב תקלות'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'מעקב תקלות', exact: true })).toHaveCount(0);
  await expect(page).toHaveTitle(/AVARIA/);
  await expect(page.locator('meta[name="application-name"]')).toHaveAttribute('content', 'AVARIA');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    'href',
    '/apple-touch-icon-backed.png',
  );
  await expect(page.locator('link[rel="icon"][sizes="32x32"]')).toHaveAttribute(
    'href',
    '/favicon-backed-32x32.png',
  );
});

test.describe('desktop sidebar', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('is visible with all destinations for an admin, in RTL document order', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const sidebar = page.getByRole('navigation', { name: 'ניווט ראשי' });
    await expect(sidebar).toBeVisible();
    const brand = page.getByTestId('brand-name');
    await expect(brand.locator('img')).toHaveAttribute(
      'src',
      '/branding/avaria-compact-micro-mark.png',
    );
    await expect(brand).toContainText('AVARIA');

    const sidebarBox = await sidebar.locator('..').boundingBox();
    expect(sidebarBox?.width).toBeCloseTo(280, 0);

    const links = sidebar.getByRole('link');
    // העברת משמרת is deliberately not a primary destination -- the /handovers
    // page/route are untouched, just not linked from navigation.
    await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון', 'כוח אדם', 'ניהול', 'ניתוחים']);

    // Mobile bottom nav must not also be visible at desktop width.
    await expect(page.getByRole('navigation', { name: 'ניווט תחתון' })).toBeHidden();

    const firstDestinationBox = await links.first().boundingBox();
    expect(firstDestinationBox?.height).toBeGreaterThanOrEqual(48);
    await expect(links.first()).toHaveAttribute('aria-current', 'page');

    const clock = page.getByTestId('desktop-live-clock');
    await expect(clock).toBeVisible();
    const time = page.getByTestId('live-clock-time');
    await expect(time).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
    await expect(page.getByTestId('live-clock-date')).not.toBeEmpty();
    const firstTime = await time.textContent();
    await expect.poll(() => time.textContent()).not.toBe(firstTime);
    await expect(clock).not.toHaveAttribute('aria-live');

    expect(await page.locator('html').getAttribute('dir')).toBe('rtl');
  });

  test('hides the admin destination for a non-admin role', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    const sidebar = page.getByRole('navigation', { name: 'ניווט ראשי' });
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'ניהול' })).toHaveCount(0);
  });
});

test('desktop sidebar is hidden at mobile width and the bottom nav takes over', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, DEMO_USERS.supervisor1);
  await expect(page.getByRole('navigation', { name: 'ניווט ראשי' })).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'ניווט תחתון' })).toBeVisible();
  await expect(page.getByTestId('desktop-live-clock')).toBeHidden();
  await expect(page.getByTestId('brand-name-mobile').locator('img')).toHaveAttribute(
    'src',
    '/branding/avaria-compact-micro-mark.png',
  );
});

test.describe('display-mode control', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('is a single direct toggle (no dropdown) that switches and persists across reload', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    const toggle = page.getByTestId('theme-toggle').first();
    await expect(toggle).toHaveAttribute('aria-label', 'מעבר למצב תצוגה כהה');
    await toggle.click();

    // Direct toggle: clicking applies the change immediately, no menu ever appears.
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('html')).toHaveClass(/dark/);
    expect(await page.evaluate(() => localStorage.getItem('takalot-theme'))).toBe('dark');
    await expect(toggle).toHaveAttribute('aria-label', 'מעבר למצב תצוגה בהיר');

    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('is keyboard operable and causes no layout shift', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    const bodyWidthBefore = await page.evaluate(() => document.body.getBoundingClientRect().height);
    const toggle = page.getByTestId('theme-toggle').first();
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveClass(/dark/);
    const bodyWidthAfter = await page.evaluate(() => document.body.getBoundingClientRect().height);
    expect(bodyWidthAfter).toBe(bodyWidthBefore);
  });
});
