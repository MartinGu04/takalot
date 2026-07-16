// Nexus branding, the desktop sidebar / mobile bottom nav split, and the
// compact display-mode control introduced in the branding & navigation PR.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test('Nexus branding appears on the login screen, not the legacy product name', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Nexus' })).toBeVisible();
  await expect(page.getByText('מערכת ניהול ומעקב תקלות')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'מעקב תקלות', exact: true })).toHaveCount(0);
  await expect(page).toHaveTitle(/Nexus/);
});

test.describe('desktop sidebar', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('is visible with all destinations for an admin, in RTL document order', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const sidebar = page.getByRole('navigation', { name: 'ניווט ראשי' });
    await expect(sidebar).toBeVisible();

    const links = sidebar.getByRole('link');
    await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'העברת משמרת', 'ארכיון', 'ניהול']);

    // Mobile bottom nav must not also be visible at desktop width.
    await expect(page.getByRole('navigation', { name: 'ניווט תחתון' })).toBeHidden();

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
});

test.describe('display-mode control', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('switches to dark, shows the current state, and persists across reload', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    const toggle = page.getByTestId('theme-toggle').first();
    await toggle.click();
    await page.getByRole('menuitemradio', { name: 'כהה' }).click();

    await expect(page.locator('html')).toHaveClass(/dark/);
    expect(await page.evaluate(() => localStorage.getItem('takalot-theme'))).toBe('dark');

    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('is keyboard operable', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    const toggle = page.getByTestId('theme-toggle').first();
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu', { name: 'בחירת מצב תצוגה' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'בחירת מצב תצוגה' })).toBeHidden();
  });
});
