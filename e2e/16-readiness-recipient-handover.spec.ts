// Incomplete-readiness closure lifecycle, the reporting-recipient field, the
// removed reported-to-operations filter, and the simplified handover flow.
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
  await dialog.getByLabel('גורם מטפל פנימי').selectOption({ label: 'ליאור אדרי (דמו)' });
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
  await dialog.getByRole('button', { name: 'המשך לאישור סגירה' }).click();
  await dialog.getByRole('button', { name: 'אישור סגירת תקלה' }).click();

  await page.goto('/archive');
  await expect(page.getByRole('link', { name: /2026-002/ })).toBeVisible();
});

test('reporting recipient is required only when reported-to-operations is "כן"', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-002/ }).click();

  await page.getByRole('button', { name: 'עדכון תקלה' }).click();
  const dialog = page.getByRole('dialog', { name: 'עדכון תקלה' });

  // Switch away from "כן" first: the recipient field must hide and not be required.
  await dialog.getByLabel('דווח למבצעים').selectOption({ label: 'לא' });
  await expect(dialog.getByLabel('למי דווח?')).toHaveCount(0);

  // Switching back to "כן" reveals the field again, empty, and required.
  await dialog.getByLabel('דווח למבצעים').selectOption({ label: 'כן' });
  await expect(dialog.getByLabel('למי דווח?')).toHaveValue('');
  await dialog.getByLabel('פעולות שבוצעו מאז העדכון הקודם').fill('דיווח למוקד המבצעים');
  await dialog.getByLabel('סטטוס נוכחי').fill('המצב הנוכחי לצורך בדיקה');
  await dialog.getByRole('button', { name: 'שמירת עדכון' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();

  await dialog.getByLabel('למי דווח?').fill('אחמ״ש מוקד מבצעים החדש');
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

test('handover creation shows a concise snapshot with no open per-incident textareas by default', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/handovers/new');

  await expect(page.getByLabel('הערת מסירה לתקלה זו (לא חובה)')).toHaveCount(0);
  const addNoteButtons = page.getByRole('button', { name: '+ הוסף הערה' });
  await expect(addNoteButtons.first()).toBeVisible();

  await addNoteButtons.first().click();
  await expect(page.getByLabel('הערת מסירה לתקלה זו (לא חובה)')).toHaveCount(1);
});

test('handover can be submitted with no individual incident notes', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/handovers/new');
  await page.getByLabel('אחמ״ש נכנס').selectOption({ label: 'מאיה רוזן (דמו)' });
  await page.getByRole('button', { name: 'שליחת העברת משמרת' }).click();
  await expect(page.getByRole('heading', { name: 'העברת משמרת' })).toBeVisible();
});
