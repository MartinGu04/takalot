import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test('shift supervisor creates an incident, assigns a technician, adds an update, and closes it', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);

  await page.goto('/incidents/new');
  await page.getByLabel('מערכת / עמדה').selectOption({ label: 'מערכת בטא' });
  await page.getByLabel('מיקום').selectOption({ label: 'אתר 1' });
  await page.getByLabel('תיאור התקלה').fill('בדיקת קצה לקצה: תקלה נוצרה על ידי מבחן אוטומטי');
  await page.getByLabel('השפעה מבצעית').fill('השפעה מבצעית לבדיקה אוטומטית');
  await page.getByLabel('פעולות שבוצעו עד כה').fill('נבדק ראשונית על ידי הבדיקה האוטומטית');
  await page.getByLabel('בעל אחריות פנימי').selectOption({ label: 'יואב כהן (דמו)' });
  await page.locator('form button[type="submit"]').click();

  // Redirects to the new incident's detail page with a success confirmation.
  await expect(page.getByRole('status')).toContainText('נפתחה בהצלחה');
  const numberMatch = await page.locator('h1').innerText();
  expect(numberMatch).toMatch(/\d{4}-\d{3}/);

  // Assign a technician.
  await page.getByRole('button', { name: 'שינוי גורם מטפל' }).click();
  const assignDialog = page.getByRole('dialog', { name: 'שינוי גורם מטפל' });
  await assignDialog.getByLabel('גורם מטפל פנימי').selectOption({ label: 'עומר פרץ (דמו)' });
  await assignDialog.locator('form button[type="submit"]').click();
  await expect(page.getByRole('definition').filter({ hasText: 'עומר פרץ (דמו)' })).toBeVisible();

  // Add an operational update moving the incident forward.
  await page.getByRole('button', { name: 'עדכון תקלה' }).click();
  const updateDialog = page.getByRole('dialog', { name: 'עדכון תקלה' });
  await updateDialog.getByLabel('פעולות שבוצעו מאז העדכון הקודם').fill('בוצעה בדיקה ראשונית והתקלה אותרה');
  await updateDialog.getByLabel('סטטוס נוכחי').selectOption({ value: 'in_progress' });
  await updateDialog.locator('form button[type="submit"]').click();
  await expect(page.getByText('העדכון נשמר')).toBeVisible();

  // Close the incident through the dedicated closure flow.
  await page.getByRole('button', { name: 'סגירת תקלה' }).click();
  const closeDialog = page.getByRole('dialog', { name: 'סגירת תקלה' });
  await closeDialog.getByLabel('סיבת התקלה').fill('סיבת התקלה שזוהתה במהלך הבדיקה האוטומטית');
  await closeDialog.getByLabel('הפתרון שבוצע').fill('הפתרון שבוצע לתיקון התקלה');
  await closeDialog.getByRole('button', { name: 'המשך לאישור סגירה' }).click();
  await closeDialog.getByRole('button', { name: 'אישור סגירת תקלה' }).click();

  await expect(page.getByText('נסגרה', { exact: false }).first()).toBeVisible();
  await expect(page.locator('text=סיכום סגירה')).toBeVisible();
});
