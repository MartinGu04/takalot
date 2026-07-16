import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test('supervisor creates a handover and another supervisor accepts it', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);

  await page.goto('/handovers/new');
  await page.getByLabel('אחמ״ש נכנס').selectOption({ label: 'מאיה רוזן (דמו)' });
  await page.getByLabel('הערה כללית').fill('בדיקת קצה לקצה של העברת משמרת');
  await page.getByRole('button', { name: 'שליחת העברת משמרת' }).click();

  await expect(page.getByRole('heading', { name: 'העברת משמרת' })).toBeVisible();
  await expect(page.getByText('ממתינה לאישור')).toBeVisible();
  const url = page.url();

  // Switch to the incoming supervisor via the demo role switcher and accept.
  await page.getByTestId('demo-role-switcher').selectOption({ value: DEMO_USERS.supervisor2 });
  await page.goto(url);
  await expect(page.getByText('בדיקת קצה לקצה של העברת משמרת')).toBeVisible();
  await page.getByRole('button', { name: 'אישור קבלת המשמרת' }).click();

  await expect(page.getByText('אושרה').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'אישור קבלת המשמרת' })).toHaveCount(0);
});
