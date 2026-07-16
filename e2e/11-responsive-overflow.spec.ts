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
  await expect(page.getByLabel('מתאריך')).toBeVisible();
  await expect(page.getByLabel('עד תאריך')).toBeVisible();
});
