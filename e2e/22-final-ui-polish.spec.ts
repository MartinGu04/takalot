import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test('sidebar reveals the signed-in full name on hover and on keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAs(page, DEMO_USERS.supervisor1);

  const sidebar = page.locator('aside');
  // The full value appears twice by design (the truncated trigger and the
  // tooltip it describes) -- target the trigger specifically.
  const name = sidebar.locator('span[tabindex="0"]', { hasText: 'יואב כהן (דמו)' });
  const tooltip = sidebar.getByRole('tooltip');

  // Present and associated at all times, but visually hidden at rest.
  await expect(tooltip).toHaveText('יואב כהן (דמו)');
  await expect(tooltip).toHaveCSS('opacity', '0');

  await name.hover();
  await expect(tooltip).toHaveCSS('opacity', '1');

  // Keyboard focus reveals it too -- the case a plain title= cannot cover.
  await page.mouse.move(0, 0);
  await expect(tooltip).toHaveCSS('opacity', '0');
  await name.focus();
  await expect(tooltip).toHaveCSS('opacity', '1');
});

test('archive incident cards align right and keep mixed-direction text readable', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/archive');
  await expect(page.getByRole('heading', { name: 'ארכיון תקלות סגורות' })).toBeVisible();

  const card = page.locator('a.incident-card').first();
  await expect(card).toBeVisible();

  // Hebrew content resolves right-aligned under the page's RTL direction.
  const impact = card.locator('p.line-clamp-2');
  await expect(impact).toHaveCSS('text-align', 'start');

  // The divider sits on the metadata column's right edge -- the seam facing
  // the content column -- not on its outer left edge.
  const metadata = card.locator('div.sm\\:border-s');
  const borders = await metadata.evaluate((el) => {
    const s = getComputedStyle(el);
    return { right: s.borderRightWidth, left: s.borderLeftWidth };
  });
  expect(parseFloat(borders.right)).toBeGreaterThan(0);
  expect(parseFloat(borders.left)).toBe(0);
});

test('a mixed Hebrew+Latin external-handler name renders in its own base direction', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAs(page, DEMO_USERS.supervisor1);

  // Put the exact mixed string on an incident's additive external handling
  // party through the real assign flow. The internal owner (mandatory,
  // migration 0032) is left untouched -- external handling is a separate,
  // additive fact, never a substitute for it.
  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-001/ }).first().click();
  await expect(page.getByRole('heading', { name: /2026-001/ })).toBeVisible();
  await page.getByRole('button', { name: 'שינוי גורם מטפל' }).click();
  const dialog = page.getByRole('dialog', { name: 'שינוי גורם מטפל' });
  await dialog.getByLabel('גורם מטפל חיצוני').fill('טיפול של אלתא (IAF)');
  await dialog.getByRole('button', { name: 'עדכון גורם מטפל' }).click();
  await expect(dialog).toBeHidden();

  // Compact contexts (the incidents list) never substitute the external
  // handler for the internal owner -- the mixed name only ever appears on
  // the detail page's own, separate "גורם מטפל חיצוני" fact (a <dd>; the
  // timeline's own entry for this same change is a <strong>, not a
  // definition, so scoping to role="definition" disambiguates the two).
  const owner = page.getByRole('definition').filter({ hasText: 'טיפול של אלתא (IAF)' });
  await expect(owner).toBeVisible();
  await expect(owner).toHaveAttribute('dir', 'auto');
  // First strong character is Hebrew, so the resolved base direction is RTL
  // and the trailing "(IAF)" keeps its parentheses oriented correctly.
  await expect(owner).toHaveCSS('direction', 'rtl');
});

test('personnel rows group by role hierarchy and expose actions through one menu', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAs(page, DEMO_USERS.admin);
  await page.goto('/personnel');
  await page.getByRole('tab', { name: /^פעילים/ }).click();

  const headings = page.locator('main section[aria-labelledby^="personnel-group-"] > h2');
  await expect(headings).toHaveText([
    /^מנהל מערכת/,
    /^נגד/,
    /^אחמ״ש/,
    /^טכנאי/,
    /^צפייה בלבד/,
  ]);

  // Edit/delete are not visible controls any more.
  const row = page.locator('[data-personnel-row]', { hasText: 'עומר פרץ (דמו)' });
  await expect(row.getByRole('button', { name: 'עריכה' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'מחיקה' })).toHaveCount(0);

  const trigger = row.getByRole('button', { name: /^פעולות עבור / });
  await trigger.click();
  // The menu is portaled to the document body (viewport-clamped, like every
  // other floating panel in the app) rather than nested under the row.
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'עריכה' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'מחיקה' })).toBeVisible();

  // Escape dismisses and hands focus back to the trigger.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // Outside click also dismisses.
  await trigger.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByRole('heading', { name: 'כוח אדם' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('incident actions keep their hierarchy while closure and reassignment read distinctly', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAs(page, DEMO_USERS.admin);
  await page.getByRole('link', { name: /2026-001/ }).click();
  await expect(page.getByRole('heading', { name: /2026-001/ })).toBeVisible();

  const actions = page.getByRole('region', { name: 'פעולות תקלה' });
  const update = actions.getByRole('button', { name: 'עדכון תקלה' });
  const close = actions.getByRole('button', { name: 'סגירת תקלה' });
  const assign = actions.getByRole('button', { name: 'שינוי גורם מטפל' });

  const bg = (locator: typeof update) =>
    locator.evaluate((el) => getComputedStyle(el).backgroundColor);

  // Update remains the only filled action; the other two are distinct from
  // it and from each other.
  const [updateBg, closeBg, assignBg] = [await bg(update), await bg(close), await bg(assign)];
  expect(new Set([updateBg, closeBg, assignBg]).size).toBe(3);
});
