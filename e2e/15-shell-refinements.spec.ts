// Usability/shell-behavior refinements: bulk-selection removed, sticky
// desktop sidebar, dashboard open-incidents summary, and viewport-safe
// notification popover.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test('incidents page has no bulk-selection toggle or checkboxes', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  await expect(page.getByRole('button', { name: 'בחירה' })).toHaveCount(0);
  await expect(page.locator('input[type="checkbox"][aria-label*="בחירת תקלה"]')).toHaveCount(0);
  // Export is still available, as a single consolidated control.
  await expect(page.getByRole('button', { name: 'ייצוא', exact: true })).toBeVisible();
});

test.describe('sticky desktop sidebar', () => {
  // A short viewport guarantees the incidents list is taller than the
  // viewport (and thus actually scrollable) regardless of how many demo
  // incidents happen to be seeded.
  test.use({ viewport: { width: 1280, height: 500 } });

  test('stays fixed in place while the incidents list scrolls', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/incidents');
    // Measure the brand link at the top of the sidebar shell (not the nav
    // list within it, which sits lower down under the brand/CTA rows).
    const brand = page.getByTestId('brand-name');
    const before = await brand.boundingBox();
    expect(before).not.toBeNull();

    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(150);

    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBeGreaterThan(0);

    const after = await brand.boundingBox();
    expect(after?.y).toBe(before?.y);
    expect(after?.x).toBe(before?.x);
  });

  test('does not create desktop horizontal overflow on archive/admin/handovers', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    for (const path of ['/archive', '/admin', '/handovers']) {
      await page.goto(path);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `${path}: scrollWidth (${scrollWidth}) must not exceed clientWidth (${clientWidth})`).toBeLessThanOrEqual(clientWidth);
    }
  });
});

test.describe('open-incidents summary', () => {
  test('the primary open-incidents card opens a summary, and an item navigates to its detail page', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.getByRole('button', { name: 'תקלות פתוחות' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: /תקלות פתוחות/ })).toBeVisible();

    const firstItem = dialog.getByRole('link', { name: /2026-001/ });
    await expect(firstItem).toBeVisible();
    await firstItem.click();

    await expect(page).toHaveURL(/\/incidents\/inc-/);
    await expect(page.getByRole('heading', { name: /2026-001/ })).toBeVisible();
  });

  test('the footer action navigates to the full incidents list', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.getByRole('button', { name: 'תקלות פתוחות' }).click();
    await page.getByRole('link', { name: 'לכל התקלות הפתוחות' }).click();
    await expect(page).toHaveURL(/\/incidents$/);
  });

  test('closes on Escape and does not trap the page underneath', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.getByRole('button', { name: 'תקלות פתוחות' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('notification popover stays inside the viewport', () => {
  for (const width of [320, 390, 1440]) {
    test(`at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await loginAs(page, DEMO_USERS.supervisor1);
      const before = await page.evaluate(() => document.documentElement.scrollWidth);

      await page.getByTestId('notifications-button').click();
      const panel = page.getByText('התראות', { exact: true }).locator('..').locator('..');
      await expect(panel).toBeVisible();

      const box = await panel.boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      }

      const after = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(after).toBe(before);
      expect(after).toBeLessThanOrEqual(width);
    });
  }
});

test.describe('dashboard KPI responsive layout', () => {
  test('open-incidents card spans the full row on mobile, with the other two side by side below it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await loginAs(page, DEMO_USERS.supervisor1);

    const primary = page.getByRole('button', { name: 'תקלות פתוחות' });
    const critical = page.getByText('קריטיות / גבוהות').locator('..').locator('..');
    const overdueStat = page.getByText('עדכונים באיחור', { exact: true }).locator('..').locator('..');

    const primaryBox = await primary.boundingBox();
    const criticalBox = await critical.boundingBox();
    const overdueBox = await overdueStat.boundingBox();
    expect(primaryBox && criticalBox && overdueBox).toBeTruthy();
    if (primaryBox && criticalBox && overdueBox) {
      // Primary card is wider than either secondary card (spans the row).
      expect(primaryBox.width).toBeGreaterThan(criticalBox.width);
      // The two secondary cards sit side by side (roughly the same vertical position).
      expect(Math.abs(criticalBox.y - overdueBox.y)).toBeLessThan(5);
      // ...and below the primary card.
      expect(criticalBox.y).toBeGreaterThan(primaryBox.y);
    }
  });

  test('desktop: the primary card is visibly wider than each secondary card', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, DEMO_USERS.supervisor1);

    const primaryBox = await page.getByRole('button', { name: 'תקלות פתוחות' }).boundingBox();
    const criticalBox = await page.getByText('קריטיות / גבוהות').locator('..').locator('..').boundingBox();
    expect(primaryBox && criticalBox).toBeTruthy();
    if (primaryBox && criticalBox) {
      expect(primaryBox.width).toBeGreaterThan(criticalBox.width * 1.1);
    }
  });
});
