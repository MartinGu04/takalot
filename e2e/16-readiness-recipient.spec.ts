// Incomplete-readiness closure lifecycle, the reporting-recipient field, and
// the removed reported-to-operations filter.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test('closing with partial readiness keeps the incident active, not closed', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-002/ }).click();
  await page.getByRole('button', { name: 'סגירת תקלה' }).click();

  const dialog = page.getByRole('dialog', { name: 'סגירת תקלה' });
  await dialog.getByLabel('סיבת התקלה').fill('תקלת חומרה בכרטיס');
  await dialog.getByLabel('הפתרון שבוצע').fill('הותקן פתרון זמני');
  await dialog.getByLabel('כשירות המערכת').selectOption({ label: 'חלקית' });
  await dialog.getByLabel('פעולות המשך').fill('להזמין רכיב קבוע');
  await dialog.getByLabel('בעל אחריות פנימי').selectOption({ label: 'ליאור אדרי (דמו)' });
  await dialog.getByRole('button', { name: 'המשך לאישור סגירה' }).click();

  await expect(dialog.getByText('התקלה לא תיסגר')).toBeVisible();
  await dialog.getByRole('button', { name: 'אישור ושמירה' }).click();

  await expect(page.getByText('כשירות חלקית').first()).toBeVisible();
  await expect(page).toHaveURL(/\/incidents\/inc-2/);

  // Stays active: visible on the active incidents page, not the archive.
  await page.goto('/incidents');
  await expect(page.getByRole('link', { name: /2026-002/ })).toBeVisible();
  await page.goto('/archive');
  await expect(page.getByRole('link', { name: /2026-002/ })).toHaveCount(0);
});

test('closing with full readiness still closes the incident normally', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-002/ }).click();
  await page.getByRole('button', { name: 'סגירת תקלה' }).click();

  const dialog = page.getByRole('dialog', { name: 'סגירת תקלה' });
  await dialog.getByLabel('סיבת התקלה').fill('תקלת חומרה בכרטיס');
  await dialog.getByLabel('הפתרון שבוצע').fill('הוחלף הכרטיס ואומתה תקינות');
  await dialog.getByLabel('הגורם שאומת').selectOption({ label: 'ציוד או חומרה' });
  await dialog.getByLabel('תוצאת הטיפול').selectOption({ label: 'פתרון קבוע' });
  await dialog.getByLabel('מה ידוע על מה שהוביל לפתרון?').selectOption({ label: 'לא בוצעה פעולה' });
  await dialog.getByRole('button', { name: 'המשך לאישור סגירה' }).click();
  await dialog.getByRole('button', { name: 'אישור סגירת תקלה' }).click();

  await page.goto('/archive');
  await expect(page.getByRole('link', { name: /2026-002/ })).toBeVisible();
});

test('update-specific reporting recipient is required only when the answer is "כן"', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-002/ }).click();

  await page.getByRole('button', { name: 'עדכון תקלה' }).click();
  const dialog = page.getByRole('dialog', { name: 'עדכון תקלה' });

  // Starts unanswered -- no recipient field, no default answer.
  await expect(dialog.getByLabel('דווח למבצעים?')).toHaveValue('');
  await expect(dialog.getByLabel(/^למי דווח\? \(מבצעים\)/)).toHaveCount(0);

  // Switching to "לא" (a real answer) still shows no recipient field.
  await dialog.getByLabel('דווח למבצעים?').selectOption({ label: 'לא' });
  await expect(dialog.getByLabel(/^למי דווח\? \(מבצעים\)/)).toHaveCount(0);

  // Switching to "כן" reveals the field, empty, and required.
  await dialog.getByLabel('דווח למבצעים?').selectOption({ label: 'כן' });
  await expect(dialog.getByLabel(/^למי דווח\? \(מבצעים\)/)).toHaveValue('');
  await dialog.getByLabel('פעולות שבוצעו מאז העדכון הקודם').fill('דיווח למוקד המבצעים');
  await dialog.getByLabel('סטטוס נוכחי').fill('המצב הנוכחי לצורך בדיקה');
  await dialog.getByLabel('האם דווח לתקשוב למבצעים?').selectOption({ label: 'לא' });
  await dialog.getByLabel('האם עודכן ב-WISDOM?').selectOption({ label: 'לא' });
  await dialog.getByRole('button', { name: 'שמירת עדכון' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();

  await dialog.getByLabel(/^למי דווח\? \(מבצעים\)/).fill('אחמ״ש מוקד מבצעים החדש');
  await dialog.getByRole('button', { name: 'שמירת עדכון' }).click();
  await expect(dialog).toHaveCount(0);

  // Recipient is now shown clearly on the incident detail page and in the timeline.
  await expect(page.getByText('אחמ״ש מוקד מבצעים החדש').first()).toBeVisible();
});

test('the reported-to-operations filter is no longer offered on the active incidents page', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  await expect(page.getByLabel('סינון לפי דיווח למבצעים')).toHaveCount(0);
});
