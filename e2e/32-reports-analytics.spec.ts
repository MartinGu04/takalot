// ניתוחים (Analytics): the ניתוח תקלות operational analytics page at
// /reports, exposed to every authenticated role (no capability gate, same
// as the former דוחות placeholder it replaces). See src/pages/ReportsPage.tsx
// and navItems.tsx.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test('an unauthenticated visit to /reports redirects to the login screen', async ({ page }) => {
  await page.goto('/reports');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('brand-name')).toBeVisible();
});

test.describe('desktop sidebar', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  for (const [label, userId] of [
    ['system_admin', DEMO_USERS.admin],
    ['technician', DEMO_USERS.tech1],
    ['viewer', DEMO_USERS.viewer],
  ] as const) {
    test(`${label} sees ניתוחים in the sidebar and can navigate to it`, async ({ page }) => {
      await loginAs(page, userId);
      const sidebar = page.getByRole('navigation', { name: 'ניווט ראשי' });
      const analyticsLink = sidebar.getByRole('link', { name: 'ניתוחים' });
      await expect(analyticsLink).toBeVisible();
      await expect(analyticsLink).not.toHaveAttribute('aria-current', 'page');

      await analyticsLink.click();
      await expect(page).toHaveURL(/\/reports$/);
      await expect(page.getByRole('heading', { name: 'ניתוח תקלות' })).toBeVisible();
      await expect(page.getByText('מגמות, ביצועים ונקודות שדורשות תשומת לב')).toBeVisible();

      // Active-route highlighting.
      await expect(analyticsLink).toHaveAttribute('aria-current', 'page');
      await expect(sidebar.getByRole('link', { name: 'מצב נוכחי' })).not.toHaveAttribute(
        'aria-current',
        'page',
      );
    });
  }

  test('direct route access (deep link) loads the analytics page for an already-signed-in session', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'ניתוח תקלות' })).toBeVisible();
    await expect(page.getByText('אין הרשאה')).toHaveCount(0);
  });

  test('renders all six KPI cards, the trend chart and the top-systems section, with no out-of-scope terms', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'ניתוח תקלות' })).toBeVisible();

    for (const label of [
      'נפתחו בתקופה',
      'נסגרו בתקופה',
      'זמן סגירה ממוצע',
      'פתוחות עכשיו',
      'משך פתיחה ממוצע',
      'נפתחו מחדש',
    ]) {
      // exact: true -- the top-systems rows also render short chip labels
      // ("נפתחו" / "פתוחות" / "זמן סגירה"), which are substrings of some
      // KPI card labels and would otherwise collide under a loose match.
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    await expect(page.getByRole('heading', { name: 'פתיחת וסגירת תקלות' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'מערכות עם הכי הרבה תקלות' })).toBeVisible();

    await expect(page.getByText('עדכונים באיחור')).toHaveCount(0);
    await expect(page.getByText('העברת משמרת')).toHaveCount(0);
  });

  test('changing a filter updates the URL and re-renders without a full page error', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'ניתוח תקלות' })).toBeVisible();

    const periodGroup = page.getByRole('group', { name: 'תקופה' });
    await periodGroup.getByRole('button', { name: '90 ימים' }).click();
    await expect(page).toHaveURL(/[?&]period=90/);
    await expect(periodGroup.getByRole('button', { name: '90 ימים' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'איפוס סינונים' }).click();
    await expect(page).toHaveURL(/\/reports$/);
    await expect(periodGroup.getByRole('button', { name: '30 ימים' })).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('mobile navigation', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a role without Personnel/Admin access gets ניתוחים as its 4th bottom-nav destination', async ({ page }) => {
    await loginAs(page, DEMO_USERS.viewer);
    const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
    await expect(bottomNav).toBeVisible();
    const analyticsLink = bottomNav.getByRole('link', { name: 'ניתוחים' });
    await expect(analyticsLink).toBeVisible();

    await analyticsLink.click();
    await expect(page).toHaveURL(/\/reports$/);
    await expect(page.getByRole('heading', { name: 'ניתוח תקלות' })).toBeVisible();
    await expect(analyticsLink).toHaveAttribute('aria-current', 'page');

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(391);
  });

  test('the six KPI cards and chart render without horizontal overflow at mobile width', async ({ page }) => {
    await loginAs(page, DEMO_USERS.viewer);
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'ניתוח תקלות' })).toBeVisible();
    for (const label of ['נפתחו בתקופה', 'נסגרו בתקופה', 'פתוחות עכשיו', 'נפתחו מחדש']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(391);
  });

  test('a role with Personnel access reaches ניתוחים through the עוד overflow sheet, not direct URL access alone', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
    const links = bottomNav.getByRole('link').filter({ hasText: /\S/ });
    // Direct destinations unaffected; ניתוחים (and כוח אדם) move into עוד --
    // see e2e/33-mobile-nav-overflow.spec.ts for full coverage.
    await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון']);

    const moreButton = bottomNav.getByRole('button', { name: 'עוד' });
    await expect(moreButton).toBeVisible();
    await moreButton.click();
    const sheet = page.getByRole('dialog', { name: 'עוד' });
    await sheet.getByRole('link', { name: 'ניתוחים' }).click();
    await expect(page).toHaveURL(/\/reports$/);
    await expect(page.getByRole('heading', { name: 'ניתוח תקלות' })).toBeVisible();
  });
});
