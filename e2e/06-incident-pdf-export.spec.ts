import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loginAs, DEMO_USERS } from './helpers';

// Note: headless Chromium in this sandbox cannot report Hebrew `download`
// attribute values through suggestedFilename() (confirmed independent of this
// app — see src/exports/filenames.test.ts, which verifies the exact Hebrew
// file name "תקלה-2026-001.pdf" directly). Here we verify the real PDF bytes.

test('authorized user exports a complete incident PDF', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);

  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-001/ }).click();
  await expect(page.getByRole('heading', { name: /2026-001/ })).toBeVisible();

  await page.getByRole('button', { name: 'פעולות נוספות' }).click();
  const moreActions = page.getByRole('menu', { name: 'פעולות נוספות לתקלה' });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    moreActions.getByRole('menuitem', { name: 'ייצוא PDF' }).click(),
  ]);
  await expect(page.getByText('קובץ ה-PDF הופק בהצלחה')).toBeVisible();

  const filePath = await download.path();
  expect(filePath).toBeTruthy();
  const bytes = readFileSync(filePath!);
  expect(bytes.slice(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(1000);
});
