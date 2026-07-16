import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test('viewer attempts mutation and is blocked', async ({ page }) => {
  await loginAs(page, DEMO_USERS.viewer);

  // Unauthorized direct URL navigation to the creation route.
  await page.goto('/incidents/new');
  await expect(page.getByText('אין הרשאה')).toBeVisible();

  // Unauthorized direct URL navigation to the admin route.
  await page.goto('/admin');
  await expect(page.getByText('אין הרשאה')).toBeVisible();

  // Admin destination must not even be shown in navigation.
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'ניהול' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'פתיחת תקלה' })).toHaveCount(0);

  // On an incident page, no mutating action buttons are offered to a viewer.
  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-001/ }).click();
  await expect(page.getByRole('heading', { name: /2026-001/ })).toBeVisible();
  for (const label of ['עדכון תקלה', 'שינוי גורם מטפל', 'סגירת תקלה', 'פתיחה מחדש', 'אישור קבלה']) {
    await expect(page.getByRole('button', { name: label })).toHaveCount(0);
  }

  // Export is disabled by default for viewer (no explicit backend grant).
  await expect(page.getByRole('button', { name: 'ייצוא PDF' })).toHaveCount(0);
});
