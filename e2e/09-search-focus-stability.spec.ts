// Regression coverage for: text inputs losing focus mid-word in the
// incidents list, archive, and closure form. See root causes in the PR
// description — this file proves the fix from the user's point of view:
// a full Hebrew word can be typed continuously without interruption.
import { test, expect } from '@playwright/test';
import { loginAs, typeAndCheckFocus, DEMO_USERS } from './helpers';

const WORD = 'בטא';

test('incidents list search accepts a full word without losing focus', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  const input = page.getByLabel('חיפוש תקלות');
  await typeAndCheckFocus(page, input, WORD);
  await expect(input).toHaveValue(WORD);

  // Filtering applies after the debounce window without further interaction.
  // Only inc-2 (מערכת בטא) matches -- inc-5 is also מערכת בטא but closed,
  // so it's excluded from the active incidents page by default.
  await page.waitForTimeout(500);
  await expect(page.getByText('1 תקלות תואמות')).toBeVisible();
  await expect(page.getByRole('link', { name: /2026-002/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /2026-005/ })).toHaveCount(0);
});

test('archive search accepts a full word without losing focus', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/archive');
  const input = page.getByLabel('חיפוש בארכיון');
  await typeAndCheckFocus(page, input, WORD);
  await expect(input).toHaveValue(WORD);

  // Only inc-5 (מערכת בטא) is closed; inc-2 (also בטא) is still open and
  // therefore excluded from the archive, so exactly one match is expected.
  await page.waitForTimeout(500);
  await expect(page.getByText('1 תקלות סגורות תואמות')).toBeVisible();
  await expect(page.getByRole('link', { name: /2026-005/ })).toBeVisible();
});

test('archive root-cause search accepts a full word without losing focus', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/archive');
  const input = page.getByPlaceholder('חיפוש בסיבת התקלה…');
  await typeAndCheckFocus(page, input, 'רכיב');
  await expect(input).toHaveValue('רכיב');
  await page.waitForTimeout(500);
  // inc-6's root cause is "נזק פיזי לרכיב האנטנה כתוצאה ממזג אוויר."
  await expect(page.getByText('1 תקלות סגורות תואמות')).toBeVisible();
  await expect(page.getByRole('link', { name: /2026-006/ })).toBeVisible();
});

test('archive resolution search accepts a full word without losing focus', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/archive');
  const input = page.getByPlaceholder('חיפוש בפתרון שבוצע…');
  await typeAndCheckFocus(page, input, 'רכיב');
  await expect(input).toHaveValue('רכיב');
  await page.waitForTimeout(500);
  // inc-6's resolution is "הותקן רכיב חלופי זמני. הוזמן רכיב קבוע מהספק."
  await expect(page.getByText('1 תקלות סגורות תואמות')).toBeVisible();
  await expect(page.getByRole('link', { name: /2026-006/ })).toBeVisible();
});

test('closure form root-cause and resolution fields accept a full word without losing focus', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-002/ }).click();
  await page.getByRole('button', { name: 'סגירת תקלה' }).click();
  const dialog = page.getByRole('dialog', { name: 'סגירת תקלה' });

  const rootCause = dialog.getByLabel('סיבת התקלה');
  await typeAndCheckFocus(page, rootCause, 'בדיקה של סיבת התקלה בעברית');
  await expect(rootCause).toHaveValue('בדיקה של סיבת התקלה בעברית');

  const resolution = dialog.getByLabel('הפתרון שבוצע');
  await typeAndCheckFocus(page, resolution, 'בדיקה של הפתרון שבוצע בעברית');
  await expect(resolution).toHaveValue('בדיקה של הפתרון שבוצע בעברית');
});
