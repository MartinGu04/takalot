// Retroactive closure time (PR D, migration 0033): CloseDialog's actual
// closure date/time field -- required, editable, defaults to now, bounded
// by the incident's own discovered_at and now()+5min, and distinct from
// the server-recorded time. Deliberately narrow: no reporting-field,
// export, readiness, or ownership behavior is exercised here beyond what
// already-existing specs cover.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

// datetime-local inputs use "YYYY-MM-DDTHH:mm". Shifting by a fixed offset
// on the string itself (via an arbitrary-but-consistent UTC round-trip)
// avoids needing to replicate the app's own Asia/Jerusalem conversion
// (lib/time.ts) inside the test -- the result is exactly "N hours earlier
// than whatever the field currently shows," which is all these tests need.
function shiftLocalDateTime(value: string, hours: number): string {
  const d = new Date(`${value}:00Z`);
  d.setUTCHours(d.getUTCHours() + hours);
  return d.toISOString().slice(0, 16);
}

test.describe('CloseDialog: actual closure time', () => {
  test('defaults to now, is editable, and a backdated (in-bounds) time is reflected on the detail page and timeline, distinct from the server-recorded time', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents');
    await page.getByRole('link', { name: /2026-002/ }).click();
    await page.getByRole('button', { name: 'סגירת תקלה' }).click();

    const dialog = page.getByRole('dialog', { name: 'סגירת תקלה' });
    const timeField = dialog.getByLabel('מועד סגירת התקלה בפועל');
    const nowValue = await timeField.inputValue();
    expect(nowValue).not.toBe('');

    const backdated = shiftLocalDateTime(nowValue, -2);
    await timeField.fill(backdated);

    await dialog.getByLabel('סיבת התקלה').fill('תקלת חומרה לבדיקת סגירה למפרע');
    await dialog.getByLabel('הפתרון שבוצע').fill('הוחלף הרכיב ואומתה תקינות');
    await dialog.getByRole('button', { name: 'המשך לאישור סגירה' }).click();
    await dialog.getByRole('button', { name: 'אישור סגירת תקלה' }).click();
    await expect(dialog).toBeHidden();

    // Detail page's "שעת סגירה" reflects the actual (backdated) closure
    // time, not the moment the request was submitted -- the datetime-local
    // value and formatDateTime's Hebrew output both express the same
    // Asia/Jerusalem wall-clock HH:mm, so the backdated hour:minute must
    // appear in that row.
    const backdatedHm = backdated.slice(11, 16);
    const closedAtLabel = page.getByText('שעת סגירה', { exact: true });
    await expect(closedAtLabel).toBeVisible();
    const closedAtRow = closedAtLabel.locator('xpath=..');
    await expect(closedAtRow).toContainText(backdatedHm);

    // Timeline: the closure event carries a distinct "(נרשם בשרת: …)" note
    // -- server_time stays the actual recording time, independently ~now,
    // more than 60s away from the backdated event time.
    await expect(page.getByText('נרשם בשרת:')).toBeVisible();
  });

  test('rejects a closure time before the incident was discovered, leaving the form open with entered values intact', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents');
    await page.getByRole('link', { name: /2026-002/ }).click();
    await page.getByRole('button', { name: 'סגירת תקלה' }).click();

    const dialog = page.getByRole('dialog', { name: 'סגירת תקלה' });
    const timeField = dialog.getByLabel('מועד סגירת התקלה בפועל');
    const nowValue = await timeField.inputValue();
    // 10 days back is well before any seeded incident's discoveredAt.
    await timeField.fill(shiftLocalDateTime(nowValue, -240));

    await dialog.getByLabel('סיבת התקלה').fill('סיבה לבדיקת דחיית מועד לא תקין');
    await dialog.getByLabel('הפתרון שבוצע').fill('פתרון לבדיקה');
    await dialog.getByRole('button', { name: 'המשך לאישור סגירה' }).click();

    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog).toBeVisible();
    // Entered values survive the rejection.
    await expect(dialog.getByLabel('סיבת התקלה')).toHaveValue('סיבה לבדיקת דחיית מועד לא תקין');
  });

  test('rejects a closure time in the future beyond the tolerance', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents');
    await page.getByRole('link', { name: /2026-002/ }).click();
    await page.getByRole('button', { name: 'סגירת תקלה' }).click();

    const dialog = page.getByRole('dialog', { name: 'סגירת תקלה' });
    const timeField = dialog.getByLabel('מועד סגירת התקלה בפועל');
    const nowValue = await timeField.inputValue();
    await timeField.fill(shiftLocalDateTime(nowValue, 1)); // 1 hour in the future, beyond the 5-minute tolerance

    await dialog.getByLabel('סיבת התקלה').fill('סיבה');
    await dialog.getByLabel('הפתרון שבוצע').fill('פתרון');
    await dialog.getByRole('button', { name: 'המשך לאישור סגירה' }).click();

    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test('closing without touching the field uses the default (now) and succeeds, unchanged from before this feature', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents');
    await page.getByRole('link', { name: /2026-004/ }).click();
    await page.getByRole('button', { name: 'סגירת תקלה' }).click();

    const dialog = page.getByRole('dialog', { name: 'סגירת תקלה' });
    await dialog.getByLabel('סיבת התקלה').fill('סיבה לבדיקת ברירת המחדל');
    await dialog.getByLabel('הפתרון שבוצע').fill('פתרון לבדיקת ברירת המחדל');
    await dialog.getByRole('button', { name: 'המשך לאישור סגירה' }).click();
    await dialog.getByRole('button', { name: 'אישור סגירת תקלה' }).click();
    await expect(dialog).toBeHidden();

    await page.goto('/archive');
    await expect(page.getByRole('link', { name: /2026-004/ })).toBeVisible();
  });
});
