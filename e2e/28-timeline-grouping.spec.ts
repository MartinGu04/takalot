// E2: Timeline grouping. A single full-update submission that changes both
// the treatment status and the severity produces THREE incident_events rows
// sharing one operationId (the 'update' row plus two field-change rows) --
// this exercises that they render as one grouped timeline item with a
// single "שינויים בעדכון" section, rather than three separate nodes, and
// that each grouped change keeps its own, independently-targeted correction
// action.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test.describe('Timeline: grouped update', () => {
  test('a full update changing status + severity in one submission renders as one item with one שינויים בעדכון section, and each change keeps its own correction action', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents');
    // inc-1 (2026-001): seeded critical / in_progress.
    await page.getByRole('link', { name: /2026-001/ }).click();
    await expect(page.getByRole('heading', { name: /2026-001/ })).toBeVisible();

    await page.getByRole('button', { name: 'עדכון תקלה' }).click();
    const dialog = page.getByRole('dialog', { name: 'עדכון תקלה' });
    await dialog.getByLabel('פעולות שבוצעו מאז העדכון הקודם').fill('בדיקת קיבוץ ציר זמן: עדכון אחד עם כמה שינויים');
    await dialog.getByLabel('סטטוס נוכחי').fill('הצוות במעקב אחרי החומרה הגבוהה');
    await dialog.getByLabel('מצב הטיפול').selectOption({ value: 'monitoring' });
    await dialog.getByLabel('חומרה').selectOption({ label: 'גבוהה' });
    await dialog.getByLabel('דווח למבצעים?').selectOption({ label: 'לא נדרש' });
    await dialog.getByLabel('האם דווח לתקשוב למבצעים?').selectOption({ label: 'לא' });
    await dialog.getByLabel('האם עודכן ב-WISDOM?').selectOption({ label: 'לא' });
    await dialog.getByRole('button', { name: 'שמירת עדכון' }).click();
    await expect(page.getByText('העדכון נשמר')).toBeVisible();

    // The seeded incident already carries prior update entries, so scope
    // down to THIS operation's own item via its unique actionsTaken text --
    // only the group's own top-level <li> contains that text (the nested
    // שינויים rows never repeat it), which is exactly the "one operation,
    // one item" claim under test.
    const groupItem = page
      .locator('li')
      .filter({ hasText: 'בדיקת קיבוץ ציר זמן: עדכון אחד עם כמה שינויים' })
      .first();

    // One grouped item: the update title/content appears exactly once, not
    // once per backing row (update + status_change + severity_change).
    await expect(groupItem.getByText('עדכון טיפול')).toHaveCount(1);
    await expect(groupItem.getByText('בדיקת קיבוץ ציר זמן: עדכון אחד עם כמה שינויים')).toHaveCount(1);

    // Exactly one שינויים בעדכון section, holding both field changes with
    // explicit לפני/אחרי labels (never arrow-only).
    const changesSection = groupItem.getByText('שינויים בעדכון').locator('xpath=..');
    await expect(changesSection).toHaveCount(1);
    await expect(changesSection.getByText('סטטוס:', { exact: true })).toBeVisible();
    await expect(changesSection.getByText('חומרה:', { exact: true })).toBeVisible();
    await expect(changesSection.getByText('במעקב')).toBeVisible();
    await expect(changesSection.getByText('גבוהה')).toBeVisible();
    await expect(changesSection.getByText('לפני:').first()).toBeVisible();
    await expect(changesSection.getByText('אחרי:').first()).toBeVisible();

    // The subordinate status change carries its own, independently-targeted
    // correction action -- clicking it must open the correction dialog
    // scoped to "שינוי סטטוס", not to the update as a whole.
    const statusRow = changesSection.locator('li', { hasText: 'סטטוס' }).first();
    await statusRow.getByRole('button', { name: 'תיקון רישום זה' }).click();
    const correctionDialog = page.getByRole('dialog', { name: 'תיקון רישום' });
    await expect(correctionDialog.getByText(/שינוי סטטוס/)).toBeVisible();
    await correctionDialog.getByRole('button', { name: 'ביטול' }).click();
    await expect(correctionDialog).toBeHidden();
  });
});
