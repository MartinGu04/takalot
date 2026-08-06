import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test('technician sees an assigned incident and adds a permitted technical update', async ({ page }) => {
  await loginAs(page, DEMO_USERS.tech1);

  // inc-1 is seeded as assigned to tech1.
  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-001/ }).click();
  await expect(page.getByRole('heading', { name: /2026-001/ })).toBeVisible();

  // Technical update is permitted and does not expose protected fields --
  // the structured "מצב הטיפול" control and severity stay full-update-only.
  // The new free-text "סטטוס נוכחי" field, however, is required for BOTH
  // full and technician updates.
  await page.getByRole('button', { name: 'עדכון תקלה' }).click();
  const dialog = page.getByRole('dialog', { name: 'עדכון תקלה' });
  await expect(dialog.getByLabel('מצב הטיפול')).toHaveCount(0);
  await expect(dialog.getByLabel('חומרה')).toHaveCount(0);
  await dialog.getByLabel('פעולות שבוצעו מאז העדכון הקודם').fill('בדיקה טכנית נוספת בוצעה על ידי הטכנאי');
  await dialog.getByLabel('ממצאים').fill('לא נמצאו ממצאים חדשים');
  await dialog.getByLabel('סטטוס נוכחי').fill('הטכנאי באתר, ממשיך בבדיקה.');
  await dialog.locator('form button[type="submit"]').click();

  await expect(page.getByText('העדכון נשמר')).toBeVisible();
  await expect(page.getByText('בדיקה טכנית נוספת בוצעה על ידי הטכנאי')).toBeVisible();
});

// Migration 0037: an active technician gains create_incident, close_incident
// and assign_incident -- independent of the incident's current owner -- while
// cancel_incident, reopen_incident and the full/protected update flow stay
// exactly as before.
test('technician creates an incident, then reassigns and closes an incident owned by someone else -- but still cannot cancel or reopen', async ({ page }) => {
  await loginAs(page, DEMO_USERS.tech1);

  // Creation: the CTA is now offered, and the flow works end to end.
  await page.goto('/incidents/new');
  await page.getByLabel('מערכת / עמדה').selectOption({ label: 'מערכת בטא' });
  await page.getByLabel('מיקום').selectOption({ label: 'אתר 1' });
  await page.getByLabel('תיאור התקלה').fill('בדיקת קצה לקצה: תקלה נוצרה על ידי טכנאי');
  await page.getByLabel('תחום התקלה').selectOption({ label: 'ציוד או חומרה' });
  await page.getByLabel('השפעה מבצעית').fill('השפעה מבצעית לבדיקה אוטומטית');
  await page.getByLabel('פירוט הפעולות שבוצעו עד כה').fill('נבדק ראשונית על ידי הטכנאי');
  await page.getByLabel('בעל אחריות פנימי').selectOption({ label: 'עומר פרץ (דמו)' });
  await page.locator('form button[type="submit"]').click();
  await page.getByRole('dialog', { name: 'התקלה נפתחה בהצלחה' }).getByRole('button', { name: 'המשך ללא העתקה' }).click();
  await expect(page.getByRole('status')).toContainText('נפתחה בהצלחה');

  // inc-4 (seed.ts): status "monitoring" (non-terminal), owned by
  // supervisor1 -- not this technician.
  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-004/ }).click();
  await expect(page.getByRole('heading', { name: /2026-004/ })).toBeVisible();

  // Never offered regardless of ownership: cancel/reopen and the full update
  // flow. No "פעולות נוספות" overflow at all (still no cancel_incident/
  // export_data), and technician-update stays owner-scoped, so "עדכון תקלה"
  // is also unavailable on an incident this technician does not own.
  await expect(page.getByRole('button', { name: 'פעולות נוספות' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'פתיחה מחדש' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'עדכון תקלה' })).toHaveCount(0);

  // Reassign the handling party on an incident owned by someone else.
  await page.getByRole('button', { name: 'שינוי גורם מטפל' }).click();
  const assignDialog = page.getByRole('dialog', { name: 'שינוי גורם מטפל' });
  await assignDialog.getByLabel('בעל אחריות פנימי').selectOption({ label: 'ליאור אדרי (דמו)' });
  await assignDialog.locator('form button[type="submit"]').click();
  await expect(page.getByRole('definition').filter({ hasText: 'ליאור אדרי (דמו)' })).toBeVisible();

  // Close it (full readiness) too, still as the technician actor.
  await page.getByRole('button', { name: 'סגירת תקלה' }).click();
  const closeDialog = page.getByRole('dialog', { name: 'סגירת תקלה' });
  await closeDialog.getByLabel('סיבת התקלה').fill('סיבת התקלה שזוהתה על ידי הטכנאי');
  await closeDialog.getByLabel('הפתרון שבוצע').fill('הפתרון שבוצע על ידי הטכנאי');
  await closeDialog.getByLabel('הגורם שאומת').selectOption({ label: 'ציוד או חומרה' });
  await closeDialog.getByLabel('תוצאת הטיפול').selectOption({ label: 'פתרון קבוע' });
  await closeDialog.getByLabel('מה ידוע על מה שהוביל לפתרון?').selectOption({ label: 'לא בוצעה פעולה' });
  await closeDialog.getByRole('button', { name: 'המשך לאישור סגירה' }).click();
  await closeDialog.getByRole('button', { name: 'אישור סגירת תקלה' }).click();

  // Temporary WhatsApp notification-copy modal -- dismiss without copying.
  await page.getByRole('dialog', { name: 'התקלה נסגרה בהצלחה' }).getByRole('button', { name: 'המשך ללא העתקה' }).click();

  await expect(page.getByText('נסגרה', { exact: false }).first()).toBeVisible();
  await expect(page.locator('text=סיכום סגירה')).toBeVisible();

  // Now terminal: no cancel/reopen/close/assign controls at all.
  await expect(page.getByRole('button', { name: 'סגירת תקלה' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'שינוי גורם מטפל' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'פתיחה מחדש' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'פעולות נוספות' })).toHaveCount(0);
});
