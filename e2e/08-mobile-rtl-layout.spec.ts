import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test.use({ viewport: { width: 390, height: 844 } });

test('critical screens are usable and correctly RTL at mobile width', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);

  expect(await page.locator('html').getAttribute('dir')).toBe('rtl');

  // No horizontal overflow on the dashboard at 390px width.
  const dashboardScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(dashboardScrollWidth).toBeLessThanOrEqual(391);

  // Compact bottom navigation with the prominent create action visible.
  const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
  await expect(bottomNav).toBeVisible();
  await expect(page.getByRole('link', { name: 'פתיחת תקלה חדשה' })).toBeVisible();

  // Desktop top navigation must be hidden at mobile width (bottom nav takes over).
  await expect(page.getByRole('navigation', { name: 'ניווט ראשי' })).toBeHidden();

  // Incident list, detail, and create pages: no horizontal scroll, RTL intact.
  for (const path of ['/incidents', '/archive']) {
    await page.goto(path);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(391);
    expect(await page.locator('html').getAttribute('dir')).toBe('rtl');
  }

  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-001/ }).first().click();
  const detailScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(detailScrollWidth).toBeLessThanOrEqual(391);
});
