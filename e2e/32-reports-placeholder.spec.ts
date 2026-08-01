// דוחות (Reports): a future-feature placeholder destination, exposed to
// every authenticated role (no capability gate, since the page holds no
// operational data yet). See src/pages/ReportsPage.tsx and navItems.tsx.
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
    test(`${label} sees דוחות in the sidebar and can navigate to it`, async ({ page }) => {
      await loginAs(page, userId);
      const sidebar = page.getByRole('navigation', { name: 'ניווט ראשי' });
      const reportsLink = sidebar.getByRole('link', { name: 'דוחות' });
      await expect(reportsLink).toBeVisible();
      await expect(reportsLink).not.toHaveAttribute('aria-current', 'page');

      await reportsLink.click();
      await expect(page).toHaveURL(/\/reports$/);
      await expect(page.getByRole('heading', { name: 'דוחות' })).toBeVisible();
      await expect(page.getByText('COMING SOON')).toBeVisible();
      await expect(
        page.getByText('מרכז הדוחות והניתוחים של AVARIA יתווסף בגרסה עתידית.'),
      ).toBeVisible();

      // Active-route highlighting.
      await expect(reportsLink).toHaveAttribute('aria-current', 'page');
      await expect(sidebar.getByRole('link', { name: 'מצב נוכחי' })).not.toHaveAttribute(
        'aria-current',
        'page',
      );
    });
  }

  test('direct route access (deep link) loads the Reports page for an already-signed-in session', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'דוחות' })).toBeVisible();
    await expect(page.getByText('אין הרשאה')).toHaveCount(0);
  });
});

test.describe('mobile navigation', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a role without Personnel/Admin access gets דוחות as its 4th bottom-nav destination', async ({ page }) => {
    await loginAs(page, DEMO_USERS.viewer);
    const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
    await expect(bottomNav).toBeVisible();
    const reportsLink = bottomNav.getByRole('link', { name: 'דוחות' });
    await expect(reportsLink).toBeVisible();

    await reportsLink.click();
    await expect(page).toHaveURL(/\/reports$/);
    await expect(page.getByRole('heading', { name: 'דוחות' })).toBeVisible();
    await expect(reportsLink).toHaveAttribute('aria-current', 'page');

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(391);
  });

  test('a role with Personnel access keeps its existing 4 bottom-nav destinations unchanged (דוחות still reachable via URL)', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
    const links = bottomNav.getByRole('link').filter({ hasText: /\S/ });
    await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון', 'כוח אדם']);

    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'דוחות' })).toBeVisible();
  });
});
