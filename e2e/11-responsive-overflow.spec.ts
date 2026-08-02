// Regression coverage for: horizontal page overflow in the archive (date
// inputs/filter fields extending past the viewport) at common desktop/
// tablet widths, and in the shared header that both pages render.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

const WIDTHS = [320, 390, 768, 1024, 1280, 1440];
const PAGES = ['/', '/incidents', '/archive'];

for (const path of PAGES) {
  for (const width of WIDTHS) {
    test(`no horizontal overflow at ${width}px on ${path}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await loginAs(page, DEMO_USERS.supervisor1);
      await page.goto(path);
      await page.waitForTimeout(300);

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `document scrollWidth (${scrollWidth}) must not exceed clientWidth (${clientWidth})`).toBeLessThanOrEqual(clientWidth);
    });
  }
}

test('archive filter controls remain reachable (not clipped) at 1024px', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/archive');
  // Every required filter must still be present and usable -- the fix must
  // not hide filters merely to eliminate overflow.
  await expect(page.getByLabel('חיפוש בארכיון')).toBeVisible();
  await expect(page.getByLabel('סינון לפי כשירות בסגירה')).toBeVisible();
  await expect(page.getByPlaceholder('חיפוש בסיבת התקלה…')).toBeVisible();
  await expect(page.getByPlaceholder('חיפוש בפתרון שבוצע…')).toBeVisible();
  // The date range now lives behind a single "סינון לפי תאריך" trigger
  // (see ArchiveDateFilter) instead of two permanently visible date inputs
  // -- reachable and usable still means the trigger is visible and opening
  // it reveals both fields, not that the fields sit in the bar unopened.
  const dateFilterButton = page.getByRole('button', { name: 'סינון לפי תאריך' });
  await expect(dateFilterButton).toBeVisible();
  await dateFilterButton.click();
  await expect(page.getByLabel('מתאריך')).toBeVisible();
  await expect(page.getByLabel('עד תאריך')).toBeVisible();
});

test('opening the archive date-filter popover at 390px causes no horizontal overflow, and applying a range updates the URL', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/archive');

  await page.getByRole('button', { name: 'סינון לפי תאריך' }).click();
  await expect(page.getByLabel('מתאריך')).toBeVisible();

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `document scrollWidth (${scrollWidth}) must not exceed clientWidth (${clientWidth}) with the date-filter popover open`).toBeLessThanOrEqual(clientWidth);

  await page.getByLabel('מתאריך').fill('2020-01-01');
  await page.getByLabel('עד תאריך').fill('2020-01-31');
  await page.getByRole('button', { name: 'החל סינון' }).click();

  await expect(page).toHaveURL(/[?&]from=2020-01-01/);
  await expect(page).toHaveURL(/[?&]to=2020-01-31/);
  await expect(page.getByRole('button', { name: '01.01.2020–31.01.2020' })).toBeVisible();
});
