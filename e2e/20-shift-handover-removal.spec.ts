// Regression coverage for the complete removal of the shift-handover
// (העברת משמרת) feature: no navigation entry for any role, the /handovers
// routes are no longer registered (direct navigation falls through to
// AVARIA's existing unknown-route screen, same as any other bad URL), and
// unrelated navigation/routes keep working normally.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test.describe('desktop navigation', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('administrator: העברת משמרת is absent, כוח אדם and ניהול are present', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const sidebar = page.getByRole('navigation', { name: 'ניווט ראשי' });
    const links = sidebar.getByRole('link');
    await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון', 'כוח אדם', 'ניהול', 'יומן ביקורת', 'ניתוחים']);
    await expect(sidebar.getByRole('link', { name: 'העברת משמרת' })).toHaveCount(0);
  });

  test('professional manager: no ניהול, no העברת משמרת', async ({ page }) => {
    await loginAs(page, DEMO_USERS.manager);
    const sidebar = page.getByRole('navigation', { name: 'ניווט ראשי' });
    const links = sidebar.getByRole('link');
    await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון', 'כוח אדם', 'יומן ביקורת', 'ניתוחים']);
    await expect(sidebar.getByRole('link', { name: 'העברת משמרת' })).toHaveCount(0);
  });

  test('shift supervisor: no ניהול, no העברת משמרת', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    const sidebar = page.getByRole('navigation', { name: 'ניווט ראשי' });
    const links = sidebar.getByRole('link');
    await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון', 'כוח אדם', 'ניתוחים']);
    await expect(sidebar.getByRole('link', { name: 'העברת משמרת' })).toHaveCount(0);
  });

  test('technician: no כוח אדם, no ניהול, no העברת משמרת', async ({ page }) => {
    await loginAs(page, DEMO_USERS.tech1);
    const sidebar = page.getByRole('navigation', { name: 'ניווט ראשי' });
    const links = sidebar.getByRole('link');
    await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון', 'ניתוחים']);
    await expect(sidebar.getByRole('link', { name: 'העברת משמרת' })).toHaveCount(0);
    await expect(sidebar.getByRole('link', { name: 'כוח אדם' })).toHaveCount(0);
  });

  test('viewer: no כוח אדם, no ניהול, no העברת משמרת', async ({ page }) => {
    await loginAs(page, DEMO_USERS.viewer);
    const sidebar = page.getByRole('navigation', { name: 'ניווט ראשי' });
    const links = sidebar.getByRole('link');
    await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון', 'ניתוחים']);
    await expect(sidebar.getByRole('link', { name: 'העברת משמרת' })).toHaveCount(0);
    await expect(sidebar.getByRole('link', { name: 'כוח אדם' })).toHaveCount(0);
  });

  test('unrelated navigation still works: active route is correctly marked (aria-current)', async ({ page }) => {
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

  test('role with Personnel access: כוח אדם is reachable via the עוד overflow slot, no העברת משמרת', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
    await expect(bottomNav).toBeVisible();
    const links = destinationLinks(bottomNav);
    await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון']);
    await expect(bottomNav.getByRole('link', { name: 'העברת משמרת' })).toHaveCount(0);
    await expect(bottomNav.getByRole('link', { name: 'כוח אדם' })).toHaveCount(0);

    await bottomNav.getByRole('button', { name: 'עוד' }).click();
    const sheet = page.getByRole('dialog', { name: 'עוד' });
    await expect(sheet.getByRole('link', { name: 'העברת משמרת' })).toHaveCount(0);
    await sheet.getByRole('link', { name: 'כוח אדם' }).click();
    await expect(page).toHaveURL(/\/personnel$/);
    await expect(page.getByRole('heading', { name: 'כוח אדם' })).toBeVisible();
  });

  test('role without Personnel access: bottom nav shows the 3 core destinations plus ניתוחים, no filler, no העברת משמרת', async ({ page }) => {
    await loginAs(page, DEMO_USERS.tech1);
    const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
    await expect(bottomNav).toBeVisible();
    const links = destinationLinks(bottomNav);
    await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון', 'ניתוחים']);
    await expect(bottomNav.getByRole('link', { name: 'העברת משמרת' })).toHaveCount(0);
    await expect(bottomNav.getByRole('link', { name: 'כוח אדם' })).toHaveCount(0);
  });

  test('unrelated navigation still works: the central פתיחת תקלה action', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.getByRole('link', { name: 'פתיחת תקלה חדשה' }).click();
    await expect(page).toHaveURL(/\/incidents\/new$/);
    await expect(page.getByRole('heading', { name: 'פתיחת תקלה' })).toBeVisible();
  });

  test('unrelated navigation still works: active state is correct on mobile', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
    await expect(bottomNav.getByRole('link', { name: 'מצב נוכחי' })).toHaveAttribute('aria-current', 'page');
    await bottomNav.getByRole('link', { name: 'ארכיון' }).click();
    await expect(page).toHaveURL(/\/archive$/);
    await expect(bottomNav.getByRole('link', { name: 'ארכיון' })).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('handover routes are fully removed', () => {
  test('direct navigation to /handovers falls through to the unknown-route screen', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/handovers');
    await expect(page.getByRole('heading', { name: 'העמוד לא נמצא' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'העברת משמרת' })).toHaveCount(0);
  });

  test('direct navigation to /handovers/new falls through to the unknown-route screen', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/handovers/new');
    await expect(page.getByRole('heading', { name: 'העמוד לא נמצא' })).toBeVisible();
  });

  test('direct navigation to /handovers/:id falls through to the unknown-route screen', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/handovers/ho-pending');
    await expect(page.getByRole('heading', { name: 'העמוד לא נמצא' })).toBeVisible();
  });
});
