// העברת משמרת removed from primary navigation: the freed mobile slot goes to
// כוח אדם for authorized roles; the /handovers page/route/functionality are
// completely untouched, just no longer linked from the sidebar/bottom nav.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test.describe('desktop navigation', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('authorized administrator: העברת משמרת is absent, כוח אדם and ניהול are present', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const sidebar = page.getByRole('navigation', { name: 'ניווט ראשי' });
    const links = sidebar.getByRole('link');
    await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון', 'כוח אדם', 'ניהול']);
    await expect(sidebar.getByRole('link', { name: 'העברת משמרת' })).toHaveCount(0);
  });

  test('technician: no כוח אדם, no ניהול, no העברת משמרת', async ({ page }) => {
    await loginAs(page, DEMO_USERS.tech1);
    const sidebar = page.getByRole('navigation', { name: 'ניווט ראשי' });
    const links = sidebar.getByRole('link');
    await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון']);
    await expect(sidebar.getByRole('link', { name: 'העברת משמרת' })).toHaveCount(0);
    await expect(sidebar.getByRole('link', { name: 'כוח אדם' })).toHaveCount(0);
  });

  test('viewer: no כוח אדם, no ניהול, no העברת משמרת', async ({ page }) => {
    await loginAs(page, DEMO_USERS.viewer);
    const sidebar = page.getByRole('navigation', { name: 'ניווט ראשי' });
    const links = sidebar.getByRole('link');
    await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון']);
    await expect(sidebar.getByRole('link', { name: 'העברת משמרת' })).toHaveCount(0);
    await expect(sidebar.getByRole('link', { name: 'כוח אדם' })).toHaveCount(0);
  });

  test('active route is still correctly marked (aria-current) after the removal', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const sidebar = page.getByRole('navigation', { name: 'ניווט ראשי' });
    await expect(sidebar.getByRole('link', { name: 'מצב נוכחי' })).toHaveAttribute('aria-current', 'page');
    await sidebar.getByRole('link', { name: 'תקלות' }).click();
    await expect(page).toHaveURL(/\/incidents$/);
    await expect(sidebar.getByRole('link', { name: 'תקלות' })).toHaveAttribute('aria-current', 'page');
    await expect(sidebar.getByRole('link', { name: 'מצב נוכחי' })).not.toHaveAttribute('aria-current', 'page');
  });
});

test.describe('mobile navigation', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // The bottom nav also contains the floating פתיחת תקלה action -- an icon-only
  // <a> with no visible text -- so destination links are scoped to ones with text.
  function destinationLinks(bottomNav: import('@playwright/test').Locator) {
    return bottomNav.getByRole('link').filter({ hasText: /\S/ });
  }

  test('role with Personnel access: bottom nav gains כוח אדם in the freed slot, no העברת משמרת', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
    await expect(bottomNav).toBeVisible();
    const links = destinationLinks(bottomNav);
    await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון', 'כוח אדם']);
    await expect(bottomNav.getByRole('link', { name: 'העברת משמרת' })).toHaveCount(0);

    // Reachable and functional: navigating to כוח אדם from the bottom nav works.
    await bottomNav.getByRole('link', { name: 'כוח אדם' }).click();
    await expect(page).toHaveURL(/\/personnel$/);
    await expect(page.getByRole('heading', { name: 'כוח אדם' })).toBeVisible();
  });

  test('role without Personnel access: bottom nav has exactly 3 destinations, no filler, no העברת משמרת', async ({ page }) => {
    await loginAs(page, DEMO_USERS.tech1);
    const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
    await expect(bottomNav).toBeVisible();
    const links = destinationLinks(bottomNav);
    await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון']);
    await expect(bottomNav.getByRole('link', { name: 'העברת משמרת' })).toHaveCount(0);
    await expect(bottomNav.getByRole('link', { name: 'כוח אדם' })).toHaveCount(0);
  });

  test('the central פתיחת תקלה action still works alongside the (now 4-item) bottom nav', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.getByRole('link', { name: 'פתיחת תקלה חדשה' }).click();
    await expect(page).toHaveURL(/\/incidents\/new$/);
    await expect(page.getByRole('heading', { name: 'פתיחת תקלה' })).toBeVisible();
  });

  test('no horizontal overflow and no overlap in the bottom nav with 4 items', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflowX).toBe(false);

    const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
    const navBox = await bottomNav.boundingBox();
    expect(navBox).not.toBeNull();
    if (navBox) {
      expect(navBox.x).toBeGreaterThanOrEqual(0);
      expect(navBox.x + navBox.width).toBeLessThanOrEqual(390 + 1);
    }

    // The 4 destination links themselves don't overlap -- each has a distinct,
    // non-overlapping x-range. (The floating פתיחת תקלה action is excluded: it is
    // deliberately centered and overlapping above the row, by design.)
    const links = destinationLinks(bottomNav);
    const boxes = await links.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
    const sorted = boxes.slice().sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].x).toBeGreaterThanOrEqual(sorted[i - 1].x + sorted[i - 1].width - 1);
    }
  });

  test('active state is still correct on mobile after the removal', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
    await expect(bottomNav.getByRole('link', { name: 'מצב נוכחי' })).toHaveAttribute('aria-current', 'page');
    await bottomNav.getByRole('link', { name: 'ארכיון' }).click();
    await expect(page).toHaveURL(/\/archive$/);
    await expect(bottomNav.getByRole('link', { name: 'ארכיון' })).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('handover page and route are fully preserved', () => {
  test('direct navigation to /handovers still loads the page (not deleted, just unlinked from nav)', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/handovers');
    await expect(page.getByRole('heading', { name: 'העברת משמרת' })).toBeVisible();
    // No 404 / unauthorized screen.
    await expect(page.getByText('אין הרשאה')).toHaveCount(0);
  });

  test('/handovers/new still loads and creates a handover end to end', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/handovers/new');
    await expect(page.getByRole('button', { name: 'שליחת העברת משמרת' })).toBeVisible();
  });
});
