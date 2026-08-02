import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

// "הערה נוספת" (migration 0038): one new optional, ≤600-character note on
// incident creation, full update, technician update, and closure. Shown
// clearly, labeled, under the specific event/update that created it --
// never overwriting or merging with the existing generated event text, and
// never shown at all when omitted.
test.describe('incident event notes ("הערה נוספת")', () => {
  test('creation: an entered note appears under the created event, distinct from the generated opening note; a blank note shows nothing', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents/new');
    await page.getByLabel('מערכת / עמדה').selectOption({ label: 'מערכת בטא' });
    await page.getByLabel('מיקום').selectOption({ label: 'אתר 1' });
    await page.getByLabel('תיאור התקלה').fill('בדיקת קצה לקצה: הערה נוספת בפתיחה');
    await page.getByLabel('השפעה מבצעית').fill('השפעה מבצעית לבדיקה');
    await page.getByLabel('פעולות שבוצעו עד כה').fill('נבדק ראשונית');
    await page.getByLabel('בעל אחריות פנימי').selectOption({ label: 'יואב כהן (דמו)' });
    await page.getByLabel('הערה נוספת').fill('  הערה נוספת שהוזנה בעת הפתיחה  ');
    await page.locator('form button[type="submit"]').click();
    await page.getByRole('dialog', { name: 'התקלה נפתחה בהצלחה' }).getByRole('button', { name: 'המשך ללא העתקה' }).click();

    await expect(page.getByRole('status')).toContainText('נפתחה בהצלחה');
    await expect(page.getByText(/נבדק ראשונית/)).toBeVisible();
    await expect(page.getByText('הערה נוספת:')).toBeVisible();
    await expect(page.getByText('הערה נוספת שהוזנה בעת הפתיחה')).toBeVisible();
  });

  test('creation: leaving the note blank shows no "הערה נוספת" section', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents/new');
    await page.getByLabel('מערכת / עמדה').selectOption({ label: 'מערכת בטא' });
    await page.getByLabel('מיקום').selectOption({ label: 'אתר 1' });
    await page.getByLabel('תיאור התקלה').fill('בדיקת קצה לקצה: ללא הערה');
    await page.getByLabel('השפעה מבצעית').fill('השפעה מבצעית לבדיקה');
    await page.getByLabel('פעולות שבוצעו עד כה').fill('נבדק ראשונית ללא הערה');
    await page.getByLabel('בעל אחריות פנימי').selectOption({ label: 'יואב כהן (דמו)' });
    await page.locator('form button[type="submit"]').click();
    await page.getByRole('dialog', { name: 'התקלה נפתחה בהצלחה' }).getByRole('button', { name: 'המשך ללא העתקה' }).click();

    await expect(page.getByRole('status')).toContainText('נפתחה בהצלחה');
    await expect(page.getByText(/נבדק ראשונית ללא הערה/)).toBeVisible();
    await expect(page.getByText('הערה נוספת:')).toHaveCount(0);
  });

  test('full update: a note appears under its own update entry; two separate updates keep two separate notes', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents');
    await page.getByRole('link', { name: /2026-001/ }).click();

    await page.getByRole('button', { name: 'עדכון תקלה' }).click();
    let dialog = page.getByRole('dialog', { name: 'עדכון תקלה' });
    await dialog.getByLabel(/^פעולות שבוצעו מאז העדכון הקודם/).fill('עדכון ראשון עם הערה');
    await dialog.getByLabel(/^סטטוס נוכחי/).fill('המצב הנוכחי לצורך בדיקה');
    await dialog.getByLabel('הערה נוספת').fill('הערה על העדכון הראשון');
    await dialog.getByLabel('דווח למבצעים?').selectOption({ label: 'לא נדרש' });
    await dialog.getByLabel('האם דווח לתקשוב למבצעים?').selectOption({ label: 'לא' });
    await dialog.getByLabel('האם עודכן ב-WISDOM?').selectOption({ label: 'לא' });
    await dialog.getByRole('button', { name: 'שמירת עדכון' }).click();
    await expect(page.getByText('העדכון נשמר').first()).toBeVisible();

    const firstEntry = page.getByText('עדכון ראשון עם הערה').locator('../..');
    await expect(firstEntry.getByText('הערה נוספת:')).toBeVisible();
    await expect(firstEntry.getByText('הערה על העדכון הראשון')).toBeVisible();

    // A second, separate update with its own note must not alter the first.
    await page.getByRole('button', { name: 'עדכון תקלה' }).click();
    dialog = page.getByRole('dialog', { name: 'עדכון תקלה' });
    await dialog.getByLabel(/^פעולות שבוצעו מאז העדכון הקודם/).fill('עדכון שני עם הערה אחרת');
    await dialog.getByLabel(/^סטטוס נוכחי/).fill('המצב הנוכחי לצורך בדיקה');
    await dialog.getByLabel('הערה נוספת').fill('הערה על העדכון השני');
    await dialog.getByLabel('דווח למבצעים?').selectOption({ label: 'לא נדרש' });
    await dialog.getByLabel('האם דווח לתקשוב למבצעים?').selectOption({ label: 'לא' });
    await dialog.getByLabel('האם עודכן ב-WISDOM?').selectOption({ label: 'לא' });
    await dialog.getByRole('button', { name: 'שמירת עדכון' }).click();
    await expect(page.getByText('העדכון נשמר').first()).toBeVisible();

    const secondEntry = page.getByText('עדכון שני עם הערה אחרת').locator('../..');
    await expect(secondEntry.getByText('הערה נוספת:')).toBeVisible();
    await expect(secondEntry.getByText('הערה על העדכון השני')).toBeVisible();
    // The first entry's own note is still there, untouched by the second.
    await expect(firstEntry.getByText('הערה על העדכון הראשון')).toBeVisible();
  });

  test('technician update: a note is stored and shown without exposing any protected field', async ({ page }) => {
    await loginAs(page, DEMO_USERS.tech1);
    // inc-1 is seeded as assigned to tech1.
    await page.goto('/incidents');
    await page.getByRole('link', { name: /2026-001/ }).click();

    await page.getByRole('button', { name: 'עדכון תקלה' }).click();
    const dialog = page.getByRole('dialog', { name: 'עדכון תקלה' });
    await expect(dialog.getByLabel('מצב הטיפול')).toHaveCount(0);
    await expect(dialog.getByLabel('חומרה')).toHaveCount(0);
    await dialog.getByLabel(/^פעולות שבוצעו מאז העדכון הקודם/).fill('עדכון טכני עם הערה');
    await dialog.getByLabel(/^סטטוס נוכחי/).fill('המצב הנוכחי לצורך בדיקה');
    await dialog.getByLabel('הערה נוספת').fill('הערה שהוזנה על ידי הטכנאי');
    await dialog.locator('form button[type="submit"]').click();

    await expect(page.getByText('העדכון נשמר')).toBeVisible();
    const entry = page.getByText('עדכון טכני עם הערה').locator('../..');
    await expect(entry.getByText('הערה נוספת:')).toBeVisible();
    await expect(entry.getByText('הערה שהוזנה על ידי הטכנאי')).toBeVisible();
  });

  test('closure: a note on a full-readiness close appears under the closed event, alongside its own generated summary', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents/new');
    await page.getByLabel('מערכת / עמדה').selectOption({ label: 'מערכת בטא' });
    await page.getByLabel('מיקום').selectOption({ label: 'אתר 1' });
    await page.getByLabel('תיאור התקלה').fill('בדיקת קצה לקצה: הערה בסגירה');
    await page.getByLabel('השפעה מבצעית').fill('השפעה מבצעית לבדיקה');
    await page.getByLabel('פעולות שבוצעו עד כה').fill('נבדק ראשונית');
    await page.getByLabel('בעל אחריות פנימי').selectOption({ label: 'יואב כהן (דמו)' });
    await page.locator('form button[type="submit"]').click();
    await page.getByRole('dialog', { name: 'התקלה נפתחה בהצלחה' }).getByRole('button', { name: 'המשך ללא העתקה' }).click();
    await expect(page.getByRole('status')).toContainText('נפתחה בהצלחה');

    await page.getByRole('button', { name: 'סגירת תקלה' }).click();
    const closeDialog = page.getByRole('dialog', { name: 'סגירת תקלה' });
    await closeDialog.getByLabel('סיבת התקלה').fill('סיבת התקלה שזוהתה');
    await closeDialog.getByLabel('הפתרון שבוצע').fill('הפתרון שבוצע לתיקון');
    await closeDialog.getByLabel('הערה נוספת').fill('הערה נוספת בעת הסגירה');
    await closeDialog.getByRole('button', { name: 'המשך לאישור סגירה' }).click();
    await closeDialog.getByRole('button', { name: 'אישור סגירת תקלה' }).click();
    await page.getByRole('dialog', { name: 'התקלה נסגרה בהצלחה' }).getByRole('button', { name: 'המשך ללא העתקה' }).click();

    await expect(page.getByText('נסגרה', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/סיבת התקלה שזוהתה/).first()).toBeVisible();
    await expect(page.getByText('הערה נוספת:')).toBeVisible();
    await expect(page.getByText('הערה נוספת בעת הסגירה')).toBeVisible();
  });
});
