import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loginAs, DEMO_USERS } from './helpers';

// Note: headless Chromium in this sandbox cannot report Hebrew `download`
// attribute values through suggestedFilename() (confirmed independent of this
// app — see src/exports/filenames.test.ts, which verifies the exact Hebrew
// file names directly). Here we verify the exported file's real content/bytes.

test('authorized user filters archive results and exports XLSX/CSV', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);

  await page.goto('/archive');
  await expect(page.getByRole('heading', { name: 'ארכיון תקלות סגורות' })).toBeVisible();

  await page.getByPlaceholder('חיפוש לפי מספר, מערכת, מיקום, תיאור, סיבת התקלה או הפתרון שבוצע…').fill('2026-005');
  await expect(page.getByRole('link', { name: /2026-005/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /2026-006/ })).toHaveCount(0);

  // A single "ייצוא" control opens a popover with the format options.
  await page.getByRole('button', { name: 'ייצוא', exact: true }).click();
  const [xlsxDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'ייצוא XLSX' }).click(),
  ]);
  const xlsxPath = await xlsxDownload.path();
  expect(xlsxPath).toBeTruthy();
  const xlsxBytes = readFileSync(xlsxPath!);
  expect(xlsxBytes.slice(0, 2).toString()).toBe('PK'); // xlsx is a zip archive

  await page.getByRole('button', { name: 'ייצוא', exact: true }).click();
  const [csvDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'ייצוא CSV' }).click(),
  ]);
  const csvPath = await csvDownload.path();
  expect(csvPath).toBeTruthy();
  const csvText = readFileSync(csvPath!, 'utf-8');
  expect(csvText.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM
  expect(csvText).toContain('מספר תקלה');
  expect(csvText).toContain('2026-005');
});
