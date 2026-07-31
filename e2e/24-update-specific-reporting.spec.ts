import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

// Update-specific reporting (migration 0031): three fresh per-update
// questions in the full-update flow (דווח למבצעים? / האם דווח לתקשוב
// למבצעים? / האם עודכן ב-WISDOM?), never preloaded from the incident's own
// opening-time reporting facts and never persisted onto them.
test.describe('UpdateDialog update-specific reporting', () => {
  test('starts every question unanswered, requires an explicit answer, and shows/hides recipients correctly', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    // inc-1 (2026-001) opens with reportedToOps: 'yes' -- a clearly non-blank
    // opening fact, so if the dialog were (bugged) preloading from it, the
    // select below would show 'yes' rather than the unanswered placeholder.
    await page.goto('/incidents');
    await page.getByRole('link', { name: /2026-001/ }).click();

    await page.getByRole('button', { name: 'עדכון תקלה' }).click();
    const dialog = page.getByRole('dialog', { name: 'עדכון תקלה' });

    await expect(dialog.getByLabel('דווח למבצעים?')).toHaveValue('');
    await expect(dialog.getByLabel('האם דווח לתקשוב למבצעים?')).toHaveValue('');
    await expect(dialog.getByLabel('האם עודכן ב-WISDOM?')).toHaveValue('');
    await expect(dialog.getByLabel(/^למי דווח\?/)).toHaveCount(0);
    // WISDOM never asks for a number in this flow.
    await expect(dialog.getByText('מספר תקלה ב-WISDOM')).toHaveCount(0);

    // Submitting with the questions still unanswered is blocked.
    await dialog.getByLabel('פעולות שבוצעו מאז העדכון הקודם').fill('עדכון בדיקה');
    await dialog.getByLabel('סטטוס נוכחי').fill('המצב הנוכחי לצורך בדיקה');
    await dialog.getByRole('button', { name: 'שמירת עדכון' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog).toBeVisible();

    // Answering "כן" reveals a recipient field; switching back to "לא" hides it again.
    await dialog.getByLabel('דווח למבצעים?').selectOption({ label: 'כן' });
    await expect(dialog.getByLabel(/^למי דווח\? \(מבצעים\)/)).toBeVisible();
    await dialog.getByLabel('דווח למבצעים?').selectOption({ label: 'לא' });
    await expect(dialog.getByLabel(/^למי דווח\? \(מבצעים\)/)).toHaveCount(0);

    await dialog.getByLabel('האם דווח לתקשוב למבצעים?').selectOption({ label: 'כן' });
    await expect(dialog.getByLabel(/^למי דווח\? \(תקשוב למבצעים\)/)).toBeVisible();
    await dialog.getByLabel('האם דווח לתקשוב למבצעים?').selectOption({ label: 'לא' });
    await expect(dialog.getByLabel(/^למי דווח\? \(תקשוב למבצעים\)/)).toHaveCount(0);

    await dialog.getByLabel('האם עודכן ב-WISDOM?').selectOption({ label: 'כן' });
    await expect(dialog.getByText('מספר תקלה ב-WISDOM')).toHaveCount(0);
  });

  test('persists and renders all three answers on the specific update entry, and reopening the dialog starts fresh again', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents');
    await page.getByRole('link', { name: /2026-001/ }).click();

    await page.getByRole('button', { name: 'עדכון תקלה' }).click();
    const dialog = page.getByRole('dialog', { name: 'עדכון תקלה' });

    await dialog.getByLabel('פעולות שבוצעו מאז העדכון הקודם').fill('דיווח מלא בעדכון הקצה לקצה');
    await dialog.getByLabel('סטטוס נוכחי').fill('המצב הנוכחי לצורך בדיקה');
    await dialog.getByLabel('דווח למבצעים?').selectOption({ label: 'כן' });
    await dialog.getByLabel(/^למי דווח\? \(מבצעים\)/).fill('יוסי מהמוקד');
    await dialog.getByLabel('האם דווח לתקשוב למבצעים?').selectOption({ label: 'כן' });
    await dialog.getByLabel(/^למי דווח\? \(תקשוב למבצעים\)/).fill('דנה מהתקשוב');
    await dialog.getByLabel('האם עודכן ב-WISDOM?').selectOption({ label: 'כן' });
    await dialog.getByRole('button', { name: 'שמירת עדכון' }).click();

    await expect(page.getByText('העדכון נשמר')).toBeVisible();
    const timelineEntry = page.getByText('דיווח מלא בעדכון הקצה לקצה').locator('../..');
    await expect(timelineEntry.getByText(/דווח למבצעים בעדכון זה:/)).toBeVisible();
    await expect(timelineEntry.getByText('יוסי מהמוקד')).toBeVisible();
    await expect(timelineEntry.getByText(/דווח לתקשוב למבצעים בעדכון זה:/)).toBeVisible();
    await expect(timelineEntry.getByText('דנה מהתקשוב')).toBeVisible();
    await expect(timelineEntry.getByText(/עודכן ב-WISDOM בעדכון זה:/)).toBeVisible();

    // Opening the dialog again starts every question unanswered -- none of
    // the previous submission's "כן" answers carry forward.
    await page.getByRole('button', { name: 'עדכון תקלה' }).click();
    const reopened = page.getByRole('dialog', { name: 'עדכון תקלה' });
    await expect(reopened.getByLabel('דווח למבצעים?')).toHaveValue('');
    await expect(reopened.getByLabel('האם דווח לתקשוב למבצעים?')).toHaveValue('');
    await expect(reopened.getByLabel('האם עודכן ב-WISDOM?')).toHaveValue('');
    await expect(reopened.getByLabel(/^למי דווח\?/)).toHaveCount(0);
  });

  test('technician updates never show the update-specific reporting questions', async ({ page }) => {
    await loginAs(page, DEMO_USERS.tech1);
    await page.goto('/incidents');
    await page.getByRole('link', { name: /2026-001/ }).click();

    await page.getByRole('button', { name: 'עדכון תקלה' }).click();
    const dialog = page.getByRole('dialog', { name: 'עדכון תקלה' });
    await expect(dialog.getByLabel('דווח למבצעים?')).toHaveCount(0);
    await expect(dialog.getByLabel('האם דווח לתקשוב למבצעים?')).toHaveCount(0);
    await expect(dialog.getByLabel('האם עודכן ב-WISDOM?')).toHaveCount(0);
  });
});
