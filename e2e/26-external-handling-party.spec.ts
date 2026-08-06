// Additive external handling party (migration 0032 / PR C): an external
// organization/handler is an always-optional fact alongside the (now
// uniformly mandatory) internal owner -- never a substitute for it.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test.describe('creation: the external-handler trio is optional alongside the mandatory internal owner', () => {
  test('creates an incident with an external handler, and the detail page shows both facts separately', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents/new');
    await page.getByLabel('מערכת / עמדה').selectOption({ label: 'מערכת בטא' });
    await page.getByLabel('מיקום').selectOption({ label: 'אתר 1' });
    await page.getByLabel('תיאור התקלה').fill('תקלה עם גורם מטפל חיצוני לבדיקה אוטומטית');
    await page.getByLabel('תחום התקלה').selectOption({ label: 'ציוד או חומרה' });
    await page.getByLabel('השפעה מבצעית').fill('השפעה מבצעית לבדיקה אוטומטית');
    await page.getByLabel('פעולות שבוצעו עד כה').fill('נבדק ראשונית');
    await page.getByLabel('בעל אחריות פנימי').selectOption({ label: 'יואב כהן (דמו)' });
    await page.getByLabel('גורם מטפל חיצוני').fill('ספק תחזוקה בע״מ');
    await page.getByLabel('איש קשר').fill('דנה כהן');
    await page.getByRole('button', { name: 'פתיחת תקלה' }).click();
    await page.getByRole('dialog', { name: 'התקלה נפתחה בהצלחה' }).getByRole('button', { name: 'המשך ללא העתקה' }).click();

    await expect(page.getByRole('definition').filter({ hasText: 'יואב כהן' })).toBeVisible();
    const externalRow = page.getByRole('definition').filter({ hasText: 'ספק תחזוקה בע״מ' });
    await expect(externalRow).toBeVisible();
    await expect(externalRow).toContainText('דנה כהן');
  });

  test('rejects a contact person with no external-handler name', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents/new');
    await page.getByLabel('מערכת / עמדה').selectOption({ label: 'מערכת בטא' });
    await page.getByLabel('מיקום').selectOption({ label: 'אתר 1' });
    await page.getByLabel('תיאור התקלה').fill('בדיקת דחיית איש קשר ללא שם גורם');
    await page.getByLabel('תחום התקלה').selectOption({ label: 'ציוד או חומרה' });
    await page.getByLabel('השפעה מבצעית').fill('השפעה');
    await page.getByLabel('פעולות שבוצעו עד כה').fill('נבדק');
    await page.getByLabel('בעל אחריות פנימי').selectOption({ label: 'יואב כהן (דמו)' });
    await page.getByLabel('איש קשר').fill('דנה כהן');
    await page.getByRole('button', { name: 'פתיחת תקלה' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
  });
});

test.describe('full update: preserve/update/clear semantics and a distinct timeline field', () => {
  test('setting an external handler on a full update records it as a separate field from the internal owner', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents');
    await page.getByRole('link', { name: /2026-001/ }).click();
    await page.getByRole('button', { name: 'עדכון תקלה' }).click();
    const dialog = page.getByRole('dialog', { name: 'עדכון תקלה' });
    await dialog.getByLabel('פעולות שבוצעו מאז העדכון הקודם').fill('הוספת גורם מטפל חיצוני לבדיקה');
    await dialog.getByLabel('סטטוס נוכחי').fill('בדיקה אוטומטית');
    await dialog.getByLabel('דווח למבצעים?').selectOption({ label: 'לא נדרש' });
    await dialog.getByLabel('האם דווח לתקשוב למבצעים?').selectOption({ label: 'לא' });
    await dialog.getByLabel('האם עודכן ב-WISDOM?').selectOption({ label: 'לא' });
    await dialog.getByLabel('גורם מטפל חיצוני').fill('קבלן חיצוני לבדיקה');
    await dialog.getByRole('button', { name: 'שמירת עדכון' }).click();
    await expect(dialog).toBeHidden();

    // Detail page shows the internal owner (unchanged) and the new external
    // fact, separately.
    await expect(page.getByRole('definition').filter({ hasText: 'קבלן חיצוני לבדיקה' })).toBeVisible();
    // Timeline records the change under its own field, distinct from "owner".
    await expect(page.getByText('גורם מטפל חיצוני:').first()).toBeVisible();

    // Compact contexts (the incidents list) never substitute the external
    // handler for the internal owner.
    await page.goto('/incidents');
    const card = page.getByRole('link', { name: /2026-001/ });
    await expect(card).not.toContainText('קבלן חיצוני לבדיקה');
  });
});

test.describe('assignment: internal owner is mandatory, external handler is additive', () => {
  test('assign dialog rejects submission with no internal owner selected, and accepts an external handler alongside a valid one', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents');
    await page.getByRole('link', { name: /2026-002/ }).click();
    await page.getByRole('button', { name: 'שינוי גורם מטפל' }).click();
    const dialog = page.getByRole('dialog', { name: 'שינוי גורם מטפל' });
    await dialog.getByLabel('בעל אחריות פנימי').selectOption({ label: 'עומר פרץ (דמו)' });
    await dialog.getByLabel('גורם מטפל חיצוני').fill('ארגון שותף להקצאה');
    await dialog.getByRole('button', { name: 'עדכון גורם מטפל' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('definition').filter({ hasText: 'ארגון שותף להקצאה' })).toBeVisible();
    await expect(page.getByRole('definition').filter({ hasText: 'עומר פרץ' })).toBeVisible();
  });
});

test.describe('closure: ExternalPartyFields appears at every readiness level', () => {
  test('full-readiness closure still shows and accepts the external-handler fields (OwnerField itself is not shown at full readiness)', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents');
    await page.getByRole('link', { name: /2026-004/ }).click();
    await page.getByRole('button', { name: 'סגירת תקלה' }).click();
    const dialog = page.getByRole('dialog', { name: 'סגירת תקלה' });
    // Full readiness is the default -- OwnerField must not appear here.
    await expect(dialog.getByLabel('בעל אחריות פנימי')).toHaveCount(0);
    await expect(dialog.getByLabel('גורם מטפל חיצוני')).toBeVisible();
    await dialog.getByLabel('סיבת התקלה').fill('סיבה לבדיקה אוטומטית');
    await dialog.getByLabel('הפתרון שבוצע').fill('פתרון לבדיקה אוטומטית');
    await dialog.getByLabel('גורם מטפל חיצוני').fill('ארגון בסגירה מלאה');
    await dialog.getByLabel('הגורם שאומת').selectOption({ label: 'ציוד או חומרה' });
    await dialog.getByLabel('תוצאת הטיפול').selectOption({ label: 'פתרון קבוע' });
    await dialog.getByLabel('מה ידוע על מה שהוביל לפתרון?').selectOption({ label: 'לא בוצעה פעולה' });
    await dialog.getByRole('button', { name: 'המשך לאישור סגירה' }).click();
    await dialog.getByRole('button', { name: 'אישור סגירת תקלה' }).click();
    await page.getByRole('dialog', { name: 'התקלה נסגרה בהצלחה' }).getByRole('button', { name: 'המשך ללא העתקה' }).click();

    await expect(page.getByRole('definition').filter({ hasText: 'ארגון בסגירה מלאה' })).toBeVisible();
  });
});

test.describe('regression: AssignDialog reflects the latest external contact after UpdateDialog changes it', () => {
  test('update external contact person -> open AssignDialog -> the latest contact is shown, not the stale value from initial mount', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents');
    await page.getByRole('link', { name: /2026-002/ }).click();

    // Open AssignDialog once first, locking in its local state at first mount.
    await page.getByRole('button', { name: 'שינוי גורם מטפל' }).click();
    const assignDialog = page.getByRole('dialog', { name: 'שינוי גורם מטפל' });
    await expect(assignDialog.getByLabel('איש קשר')).toHaveValue('');
    await assignDialog.getByRole('button', { name: 'ביטול' }).click();
    await expect(assignDialog).toBeHidden();

    // Change the external contact person via UpdateDialog while AssignDialog
    // stays mounted-but-closed in the background.
    await page.getByRole('button', { name: 'עדכון תקלה' }).click();
    const updateDialog = page.getByRole('dialog', { name: 'עדכון תקלה' });
    await updateDialog.getByLabel('פעולות שבוצעו מאז העדכון הקודם').fill('עדכון איש קשר חיצוני לבדיקת רגרסיה');
    await updateDialog.getByLabel('סטטוס נוכחי').fill('בדיקת רגרסיה');
    await updateDialog.getByLabel('דווח למבצעים?').selectOption({ label: 'לא נדרש' });
    await updateDialog.getByLabel('האם דווח לתקשוב למבצעים?').selectOption({ label: 'לא' });
    await updateDialog.getByLabel('האם עודכן ב-WISDOM?').selectOption({ label: 'לא' });
    await updateDialog.getByLabel('גורם מטפל חיצוני').fill('ספק לבדיקת רגרסיה');
    await updateDialog.getByLabel('איש קשר').fill('איש קשר חדש לבדיקה');
    await updateDialog.getByRole('button', { name: 'שמירת עדכון' }).click();
    await expect(updateDialog).toBeHidden();

    // Reopening AssignDialog must reflect the just-updated contact person,
    // not the stale empty value captured at its first mount.
    await page.getByRole('button', { name: 'שינוי גורם מטפל' }).click();
    await expect(assignDialog.getByLabel('איש קשר')).toHaveValue('איש קשר חדש לבדיקה');
  });
});

test.describe('legacy compatibility: an external-only incident predating the model', () => {
  test('inc-3 (legacy external-only) shows a read-only carry-over hint and requires selecting an internal owner before it can be updated', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents');
    await page.getByRole('link', { name: /2026-003/ }).click();

    // Detail page: no internal owner yet, legacy external name shown separately.
    await expect(page.getByRole('definition').filter({ hasText: 'ללא בעל אחריות פנימי' })).toBeVisible();
    await expect(
      page.getByRole('definition').filter({ hasText: 'טכנאי מטעם ספק (חברת דוגמה בע״מ)' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'עדכון תקלה' }).click();
    const dialog = page.getByRole('dialog', { name: 'עדכון תקלה' });
    // OwnerField shows the legacy carry-over hint and the external-handler
    // field is already pre-filled from the (already-backfilled) legacy value.
    await expect(dialog.getByText(/גורם מטפל חיצוני קודם:.*טכנאי מטעם ספק/)).toBeVisible();
    await expect(dialog.getByLabel('גורם מטפל חיצוני')).toHaveValue('טכנאי מטעם ספק (חברת דוגמה בע״מ)');

    // Submitting without picking an internal owner is rejected.
    await dialog.getByLabel('פעולות שבוצעו מאז העדכון הקודם').fill('ניסיון עדכון ללא בעל אחריות');
    await dialog.getByLabel('סטטוס נוכחי').fill('בדיקה');
    await dialog.getByLabel('דווח למבצעים?').selectOption({ label: 'לא נדרש' });
    await dialog.getByLabel('האם דווח לתקשוב למבצעים?').selectOption({ label: 'לא' });
    await dialog.getByLabel('האם עודכן ב-WISDOM?').selectOption({ label: 'לא' });
    await dialog.getByRole('button', { name: 'שמירת עדכון' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog).toBeVisible();

    // Picking a valid internal owner succeeds.
    await dialog.getByLabel('בעל אחריות פנימי').selectOption({ label: 'עומר פרץ (דמו)' });
    await dialog.getByRole('button', { name: 'שמירת עדכון' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('definition').filter({ hasText: 'עומר פרץ' })).toBeVisible();
    // Legacy owner_external_name-derived fact survives, unchanged.
    await expect(
      page.getByRole('definition').filter({ hasText: 'טכנאי מטעם ספק (חברת דוגמה בע״מ)' }),
    ).toBeVisible();
  });
});
