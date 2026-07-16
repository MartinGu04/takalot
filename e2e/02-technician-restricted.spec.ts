import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test('technician sees an assigned incident, adds a permitted technical update, but cannot close it', async ({ page }) => {
  await loginAs(page, DEMO_USERS.tech1);

  // inc-1 is seeded as assigned to tech1.
  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-001/ }).click();
  await expect(page.getByRole('heading', { name: /2026-001/ })).toBeVisible();

  // Close action must not be offered to a technician.
  await expect(page.getByRole('button', { name: 'סגירת תקלה' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'שינוי גורם מטפל' })).toHaveCount(0);

  // Technical update is permitted and does not expose protected fields.
  await page.getByRole('button', { name: 'עדכון תקלה' }).click();
  const dialog = page.getByRole('dialog', { name: 'עדכון תקלה' });
  await expect(dialog.getByLabel('סטטוס נוכחי')).toHaveCount(0);
  await expect(dialog.getByLabel('חומרה')).toHaveCount(0);
  await dialog.getByLabel('פעולות שבוצעו מאז העדכון הקודם').fill('בדיקה טכנית נוספת בוצעה על ידי הטכנאי');
  await dialog.getByLabel('ממצאים').fill('לא נמצאו ממצאים חדשים');
  await dialog.locator('form button[type="submit"]').click();

  await expect(page.getByText('העדכון נשמר')).toBeVisible();
  await expect(page.getByText('בדיקה טכנית נוספת בוצעה על ידי הטכנאי')).toBeVisible();
});
