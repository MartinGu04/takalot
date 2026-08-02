// Mobile bottom-nav overflow ("עוד"): the bottom nav keeps a fixed 4-slot
// layout. Roles with 4 or fewer destinations (technician, viewer) get all of
// them as direct links, including ניתוחים. Roles with more (shift_supervisor,
// professional_manager, system_admin) get 3 direct links plus a 4th "עוד"
// slot that opens a sheet with the remaining destinations. See
// src/components/Layout.tsx.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test.use({ viewport: { width: 390, height: 844 } });

test.describe('roles with 4 or fewer destinations: no overflow', () => {
  for (const [label, userId] of [
    ['viewer', DEMO_USERS.viewer],
    ['technician', DEMO_USERS.tech1],
  ] as const) {
    test(`${label}: all 4 destinations (including ניתוחים) are direct links, no עוד button`, async ({ page }) => {
      await loginAs(page, userId);
      const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
      const links = bottomNav.getByRole('link').filter({ hasText: /\S/ });
      await expect(links).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון', 'ניתוחים']);
      await expect(bottomNav.getByRole('button', { name: 'עוד' })).toHaveCount(0);
    });
  }
});

test.describe('roles with more than 4 destinations: עוד overflow sheet', () => {
  for (const [label, userId, expectedOverflow] of [
    ['shift_supervisor', DEMO_USERS.supervisor1, ['כוח אדם', 'ניתוחים']],
    ['professional_manager', DEMO_USERS.manager, ['כוח אדם', 'ניתוחים']],
    ['system_admin', DEMO_USERS.admin, ['כוח אדם', 'ניהול', 'ניתוחים']],
  ] as const) {
    test(`${label}: 3 direct destinations plus עוד holding ${expectedOverflow.join(', ')}`, async ({ page }) => {
      await loginAs(page, userId);
      const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
      const directLinks = bottomNav.getByRole('link').filter({ hasText: /\S/ });
      await expect(directLinks).toHaveText(['מצב נוכחי', 'תקלות', 'ארכיון']);

      const moreButton = bottomNav.getByRole('button', { name: 'עוד' });
      await expect(moreButton).toBeVisible();
      await expect(moreButton).toHaveAttribute('aria-expanded', 'false');
      for (const label of expectedOverflow) {
        await expect(bottomNav.getByRole('link', { name: label })).toHaveCount(0);
      }

      // Tap/click opens the sheet (Playwright's default context has no
      // touch support enabled; a click exercises the same pointer/click
      // handler a touch tap would).
      await moreButton.click();
      await expect(moreButton).toHaveAttribute('aria-expanded', 'true');
      const sheet = page.getByRole('dialog', { name: 'עוד' });
      await expect(sheet).toBeVisible();
      const sheetLinks = sheet.getByRole('link');
      await expect(sheetLinks).toHaveText(expectedOverflow as unknown as string[]);

      // Never exposes a destination the role can't access.
      if (!(expectedOverflow as readonly string[]).includes('ניהול')) {
        await expect(sheet.getByRole('link', { name: 'ניהול' })).toHaveCount(0);
      }

      // Selecting a destination navigates and closes the sheet.
      await sheet.getByRole('link', { name: 'ניתוחים' }).click();
      await expect(page).toHaveURL(/\/reports$/);
      await expect(page.getByRole('heading', { name: 'ניתוח תקלות' })).toBeVisible();
      await expect(sheet).toBeHidden();
      await expect(moreButton).toHaveAttribute('aria-expanded', 'false');
    });
  }

  test('עוד is marked as the active destination while on a route held in overflow, and the matching item is highlighted inside', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
    const moreButton = bottomNav.getByRole('button', { name: 'עוד' });
    await expect(moreButton).not.toHaveAttribute('aria-current', 'page');

    await moreButton.click();
    const sheet = page.getByRole('dialog', { name: 'עוד' });
    await sheet.getByRole('link', { name: 'ניהול' }).click();
    await expect(page).toHaveURL(/\/admin$/);

    await expect(moreButton).toHaveAttribute('aria-current', 'page');

    await moreButton.click();
    const reopened = page.getByRole('dialog', { name: 'עוד' });
    await expect(reopened.getByRole('link', { name: 'ניהול' })).toHaveAttribute('aria-current', 'page');
    await expect(reopened.getByRole('link', { name: 'כוח אדם' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('Escape dismisses the עוד sheet', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
    await bottomNav.getByRole('button', { name: 'עוד' }).click();
    const sheet = page.getByRole('dialog', { name: 'עוד' });
    await expect(sheet).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  test('clicking outside the עוד sheet dismisses it', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
    await bottomNav.getByRole('button', { name: 'עוד' }).click();
    const sheet = page.getByRole('dialog', { name: 'עוד' });
    await expect(sheet).toBeVisible();

    // Click the dimmed backdrop area above the sheet panel.
    await page.mouse.click(page.viewportSize()!.width / 2, 40);
    await expect(sheet).toBeHidden();
  });

  test('the עוד trigger is keyboard-reachable and operable with Enter', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const bottomNav = page.getByRole('navigation', { name: 'ניווט תחתון' });
    const moreButton = bottomNav.getByRole('button', { name: 'עוד' });
    await moreButton.focus();
    await expect(moreButton).toBeFocused();

    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'עוד' });
    await expect(sheet).toBeVisible();
  });

  test('desktop sidebar is unaffected by the mobile overflow pattern', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, DEMO_USERS.admin);
    const sidebar = page.getByRole('navigation', { name: 'ניווט ראשי' });
    await expect(sidebar.getByRole('link')).toHaveText([
      'מצב נוכחי', 'תקלות', 'ארכיון', 'כוח אדם', 'ניהול', 'ניתוחים',
    ]);
    await expect(sidebar.getByRole('button', { name: 'עוד' })).toHaveCount(0);
  });
});
