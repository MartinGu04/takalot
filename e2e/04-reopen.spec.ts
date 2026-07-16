import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test('professional manager reopens a closed incident', async ({ page }) => {
  await loginAs(page, DEMO_USERS.manager);

  // inc-5 is seeded as closed with full readiness.
  await page.goto('/archive');
  await page.getByRole('link', { name: /2026-005/ }).click();
  await expect(page.getByRole('heading', { name: /2026-005/ })).toBeVisible();
  await expect(page.locator('text=סיכום סגירה')).toBeVisible();

  await page.getByRole('button', { name: 'פתיחה מחדש' }).click();
  const dialog = page.getByRole('dialog', { name: 'פתיחה מחדש של תקלה' });
  await dialog.getByLabel('סיבת הפתיחה מחדש').fill('התגלה כי התקלה חזרה לאחר הסגירה, בבדיקה אוטומטית');
  await dialog.getByLabel('גורם מטפל פנימי').selectOption({ label: 'עומר פרץ (דמו)' });
  await dialog.locator('form button[type="submit"]').click();

  await expect(page.getByText('התקלה נפתחה מחדש')).toBeVisible();
  await expect(page.getByText('נפתחה מחדש').first()).toBeVisible();
});
