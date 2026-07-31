// iOS Safari (and other WebKit-based mobile browsers) auto-zooms the page
// when a focused text-entry control's computed font-size is below 16px.
// Verifies the (pointer: coarse) CSS fix in index.css actually reaches
// representative Input/Textarea/Select controls at runtime, on a touch
// context, without asserting anything about desktop/mouse contexts (where
// the smaller text-sm scale must remain untouched).
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

async function computedFontSizePx(locator: import('@playwright/test').Locator): Promise<number> {
  const value = await locator.evaluate((el) => getComputedStyle(el).fontSize);
  return parseFloat(value);
}

test.describe('touch devices: no iOS auto-zoom on form controls', () => {
  // Mirrors the existing touch-context pattern (see
  // 25-update-dialog-viewport-scroll.spec.ts) rather than a device preset --
  // hasTouch alone is what flips the (pointer: coarse) media feature that
  // the CSS fix targets.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('representative input, textarea, and select controls compute to >= 16px', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);

    // Input (free-text search) and Select (severity filter) share the
    // incidents list toolbar.
    await page.goto('/incidents');
    const searchInput = page.getByLabel('חיפוש תקלות');
    const severitySelect = page.getByLabel('סינון לפי חומרה');
    await expect(searchInput).toBeVisible();
    await expect(severitySelect).toBeVisible();
    expect(await computedFontSizePx(searchInput)).toBeGreaterThanOrEqual(16);
    expect(await computedFontSizePx(severitySelect)).toBeGreaterThanOrEqual(16);

    // Textarea (incident description) on the creation form.
    await page.goto('/incidents/new');
    const descriptionTextarea = page.getByLabel('תיאור התקלה');
    await expect(descriptionTextarea).toBeVisible();
    expect(await computedFontSizePx(descriptionTextarea)).toBeGreaterThanOrEqual(16);

    // Bypasses the shared Select component -- Layout.tsx's demo role
    // switcher renders a raw <select> directly. The CSS fix is
    // element-based, not component-based, so it must reach this too.
    const demoRoleSwitcher = page.getByTestId('demo-role-switcher');
    await expect(demoRoleSwitcher).toBeVisible();
    expect(await computedFontSizePx(demoRoleSwitcher)).toBeGreaterThanOrEqual(16);
  });
});

test.describe('desktop/mouse: unchanged smaller scale', () => {
  test('the same controls keep their normal (< 16px) desktop text-sm scale', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents');
    const searchInput = page.getByLabel('חיפוש תקלות');
    await expect(searchInput).toBeVisible();
    // text-sm resolves to 14px in this design system -- asserting it stayed
    // below 16px is what proves the fix is scoped to touch, not global.
    expect(await computedFontSizePx(searchInput)).toBeLessThan(16);
  });
});
