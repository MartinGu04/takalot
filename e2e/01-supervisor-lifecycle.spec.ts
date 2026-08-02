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

  // A successful creation first shows the temporary WhatsApp
  // notification-copy modal; dismiss it without copying to reach the new
  // incident's own detail page.
  await page.getByRole('dialog', { name: 'התקלה נפתחה בהצלחה' }).getByRole('button', { name: 'המשך ללא העתקה' }).click();

  // Redirects to the new incident's detail page with a success confirmation.
  await expect(page.getByRole('status')).toContainText('נפתחה בהצלחה');
  const numberMatch = await page.locator('h1').innerText();
  expect(numberMatch).toMatch(/\d{4}-\d{3}/);

  // Assign a technician.
  await page.getByRole('button', { name: 'שינוי גורם מטפל' }).click();
  const assignDialog = page.getByRole('dialog', { name: 'שינוי גורם מטפל' });
  await assignDialog.getByLabel('בעל אחריות פנימי').selectOption({ label: 'עומר פרץ (דמו)' });
  await assignDialog.locator('form button[type="submit"]').click();
  await expect(page.getByRole('definition').filter({ hasText: 'עומר פרץ (דמו)' })).toBeVisible();

  // Add an operational update moving the incident forward.
  await page.getByRole('button', { name: 'עדכון תקלה' }).click();
  const updateDialog = page.getByRole('dialog', { name: 'עדכון תקלה' });
  await updateDialog.getByLabel('פעולות שבוצעו מאז העדכון הקודם').fill('בוצעה בדיקה ראשונית והתקלה אותרה');
  await updateDialog.getByLabel('סטטוס נוכחי').fill('הצוות הטכני באתר, בודק את התקלה.');
  await updateDialog.getByLabel('מצב הטיפול').selectOption({ value: 'in_progress' });
  await updateDialog.getByLabel('דווח למבצעים?').selectOption({ label: 'לא נדרש' });
  await updateDialog.getByLabel('האם דווח לתקשוב למבצעים?').selectOption({ label: 'לא' });
  await updateDialog.getByLabel('האם עודכן ב-WISDOM?').selectOption({ label: 'לא' });
  await updateDialog.locator('form button[type="submit"]').click();
  await expect(page.getByText('העדכון נשמר')).toBeVisible();

  // Close the incident through the dedicated closure flow.
  await page.getByRole('button', { name: 'סגירת תקלה' }).click();
  const closeDialog = page.getByRole('dialog', { name: 'סגירת תקלה' });
  await closeDialog.getByLabel('סיבת התקלה').fill('סיבת התקלה שזוהתה במהלך הבדיקה האוטומטית');
  await closeDialog.getByLabel('הפתרון שבוצע').fill('הפתרון שבוצע לתיקון התקלה');
  await closeDialog.getByRole('button', { name: 'המשך לאישור סגירה' }).click();
  await closeDialog.getByRole('button', { name: 'אישור סגירת תקלה' }).click();

  // Same temporary WhatsApp notification-copy modal, this time for the
  // closure -- dismiss it without copying.
  await page.getByRole('dialog', { name: 'התקלה נסגרה בהצלחה' }).getByRole('button', { name: 'המשך ללא העתקה' }).click();

  await expect(page.getByText('נסגרה', { exact: false }).first()).toBeVisible();
  await expect(page.locator('text=סיכום סגירה')).toBeVisible();
});
