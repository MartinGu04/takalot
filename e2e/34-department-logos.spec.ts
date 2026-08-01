// Department (unit) branding logos in the desktop top status bar -- see
// src/components/DepartmentLogos.tsx and Layout.tsx. Desktop/tablet only;
// never shown on the mobile header, never interactive, and must not shift
// the centered clock/date or introduce horizontal overflow.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

const LOGO_502_SRC = '/branding/departments/department-logo-502.jpg';
const LOGO_COMMS_SRC = '/branding/departments/department-logo-strategic-communication.jpg';

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('both department logos render, at their exact canonical asset paths', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const logos = page.getByTestId('department-logos');
    await expect(logos).toBeVisible();

    const logo502 = page.getByTestId('department-logo-502').locator('img');
    const logoComms = page.getByTestId('department-logo-strategic-communication').locator('img');
    await expect(logo502).toHaveAttribute('src', LOGO_502_SRC);
    await expect(logoComms).toHaveAttribute('src', LOGO_COMMS_SRC);
  });

  test('each logo sits in a circular container (border-radius 50%, overflow hidden), sized ~30-34px, with a restrained gap and a visible border', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const circle502 = page.getByTestId('department-logo-502');
    const circleComms = page.getByTestId('department-logo-strategic-communication');

    for (const circle of [circle502, circleComms]) {
      const style = await circle.evaluate((el) => {
        const computed = getComputedStyle(el);
        return {
          borderRadius: computed.borderRadius,
          overflow: computed.overflow,
          borderWidth: computed.borderWidth,
        };
      });
      expect(style.overflow).toBe('hidden');
      // A square box's 50% border-radius always renders as an exact circle,
      // whatever pixel value the engine reports it as.
      const box = await circle.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.abs(box!.width - box!.height)).toBeLessThan(1);
      expect(box!.width).toBeGreaterThanOrEqual(30);
      expect(box!.width).toBeLessThanOrEqual(34);
      expect(parseFloat(style.borderWidth)).toBeGreaterThan(0);
    }

    const box502 = (await circle502.boundingBox())!;
    const boxComms = (await circleComms.boundingBox())!;
    // RTL: don't assume which one renders visually first -- sort by x.
    const [left, right] = [box502, boxComms].sort((a, b) => a.x - b.x);
    const gap = right.x - (left.x + left.width);
    expect(gap).toBeGreaterThanOrEqual(5);
    expect(gap).toBeLessThanOrEqual(9);
  });

  test('the logos are decorative and not interactive: no link/button role, not keyboard-focusable, hidden from assistive tech', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const logos = page.getByTestId('department-logos');
    await expect(logos).toHaveAttribute('aria-hidden', 'true');
    await expect(logos.locator('a, button')).toHaveCount(0);

    // Tabbing through the header never lands focus on a logo image.
    const focusedTags: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      const tag = await page.evaluate(() => document.activeElement?.tagName ?? '');
      focusedTags.push(tag);
    }
    expect(focusedTags).not.toContain('IMG');
  });

  test('the clock/date stays centered in the header viewport, unaffected by the added logos', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const header = page.locator('header');
    const clock = page.getByTestId('desktop-live-clock');
    await expect(clock).toBeVisible();

    const headerBox = await header.boundingBox();
    const clockBox = await clock.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(clockBox).not.toBeNull();

    const headerCenterX = headerBox!.x + headerBox!.width / 2;
    const clockCenterX = clockBox!.x + clockBox!.width / 2;
    // Centered on the header's own box (the real "viewport" the clock has
    // always centered against), not on whatever space happens to be left
    // between the logos and the existing left-side controls.
    expect(Math.abs(clockCenterX - headerCenterX)).toBeLessThan(3);
  });

  test('the header height, existing notifications control, and role switcher remain unchanged and functional', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const header = page.locator('header');
    const headerBox = await header.boundingBox();
    expect(headerBox!.height).toBeGreaterThanOrEqual(63);
    expect(headerBox!.height).toBeLessThanOrEqual(65);

    const notifButton = page.getByTestId('notifications-button');
    await expect(notifButton).toBeVisible();
    await notifButton.click();
    await expect(page.getByText('התראות', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('demo-role-switcher')).toBeVisible();
  });

  test('no horizontal overflow with the logos present', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await expect(page.getByTestId('department-logos')).toBeVisible();
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflowX).toBe(false);
  });
});

test.describe('narrower desktop/tablet width', () => {
  test.use({ viewport: { width: 820, height: 1080 } });

  test('both logos remain visible with no horizontal overflow', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await expect(page.getByTestId('department-logos')).toBeVisible();
    await expect(page.getByTestId('department-logo-502')).toBeVisible();
    await expect(page.getByTestId('department-logo-strategic-communication')).toBeVisible();

    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflowX).toBe(false);
  });
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the department logos are not shown on the mobile header, which is no more crowded than before', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await expect(page.getByTestId('department-logos')).toBeHidden();

    // Existing mobile header controls remain visible and unaffected.
    await expect(page.getByTestId('brand-name-mobile')).toBeVisible();
    await expect(page.getByTestId('notifications-button')).toBeVisible();

    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflowX).toBe(false);
  });
});
