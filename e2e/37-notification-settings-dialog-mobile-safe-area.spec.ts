import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

// Regression coverage for a real-device bug: opening the operational-
// notifications settings dialog (bell -> gear -> "הגדרות התראות") from inside
// the app's sticky header rendered its title/close button off-screen on a
// narrow iPhone viewport. Root cause: the header uses `backdrop-blur-sm`
// (backdrop-filter), which establishes a new containing block for
// `position: fixed` descendants -- so the dialog's fixed overlay resolved
// against the ~56px-tall header box instead of the viewport. A jsdom
// class-name assertion can't see this at all (jsdom applies no real CSS
// layout), so every assertion here is against real, browser-computed
// geometry (boundingBox / toBeInViewport), not class names or screenshots.
async function openSettingsDialog(page: import('@playwright/test').Page) {
  await loginAs(page, DEMO_USERS.admin);
  await page.getByTestId('notifications-button').click();
  await page.getByRole('button', { name: 'הגדרות התראות' }).click();
  const dialog = page.getByRole('dialog', { name: 'הגדרות התראות' });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const { label, width, height } of [
  { label: '375x812 (iPhone X/11/12/13 mini)', width: 375, height: 812 },
  { label: '390x844 (iPhone 12/13/14)', width: 390, height: 844 },
]) {
  test.describe(`Notification settings dialog on a real iPhone viewport (${label})`, () => {
    test.use({ viewport: { width, height }, hasTouch: true, isMobile: true });

    test('title and close button render fully inside the visible viewport, with a tappable close target', async ({ page }) => {
      const dialog = await openSettingsDialog(page);

      const title = page.getByRole('heading', { name: 'הגדרות התראות' });
      const closeButton = page.getByRole('button', { name: 'סגירת החלון' });

      await expect(title).toBeInViewport();
      await expect(closeButton).toBeInViewport();

      const titleBox = (await title.boundingBox())!;
      const closeBox = (await closeButton.boundingBox())!;

      // Fully inside the 0..width / 0..height box, not merely intersecting it.
      expect(titleBox.x).toBeGreaterThanOrEqual(0);
      expect(titleBox.y).toBeGreaterThanOrEqual(0);
      expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(width);
      expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(height);

      expect(closeBox.x).toBeGreaterThanOrEqual(0);
      expect(closeBox.y).toBeGreaterThanOrEqual(0);
      expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(width);
      expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(height);

      // WCAG-adjacent minimum touch target (size-11 = 44px, with a hair of
      // tolerance for sub-pixel layout rounding at these viewport widths).
      expect(closeBox.width).toBeGreaterThanOrEqual(43.9);
      expect(closeBox.height).toBeGreaterThanOrEqual(43.9);

      // The whole panel (not just header/close) stays within the viewport --
      // this is the actual bug: before the fix, the panel's computed
      // containing block was the header, not the viewport, so it rendered
      // partly negative-y (above the fold).
      const panelBox = (await dialog.boundingBox())!;
      expect(panelBox.y).toBeGreaterThanOrEqual(0);
      expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(height);
    });

    test('the approved operational-notifications switch row still renders, unchanged, inside the dialog', async ({ page }) => {
      await openSettingsDialog(page);
      const label = page.getByText('עדכונים תפעוליים').first();
      await expect(label).toBeInViewport();
      const toggle = page.getByRole('switch', { name: 'עדכונים תפעוליים' });
      await expect(toggle).toBeVisible();
    });

    test('tapping the close button closes the dialog', async ({ page }) => {
      const dialog = await openSettingsDialog(page);
      await page.getByRole('button', { name: 'סגירת החלון' }).click();
      await expect(dialog).not.toBeVisible();
    });

    test('clicking the backdrop closes the dialog', async ({ page }) => {
      const dialog = await openSettingsDialog(page);
      // Click far enough from the panel (top-left corner) to guarantee we hit
      // the backdrop itself, not the panel or its children.
      await page.mouse.click(4, 4);
      await expect(dialog).not.toBeVisible();
    });

    test('the panel never overflows above or below the visual viewport, including with a simulated notch/home-indicator safe area', async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'Safe-area-inset simulation uses a Chromium-only CDP API.');
      const client = await page.context().newCDPSession(page);
      await client.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { top: 59, right: 0, bottom: 34, left: 0 },
      });

      const dialog = await openSettingsDialog(page);
      const panelBox = (await dialog.boundingBox())!;
      expect(panelBox.y).toBeGreaterThanOrEqual(0);
      expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(height);

      await expect(page.getByRole('heading', { name: 'הגדרות התראות' })).toBeInViewport();
      await expect(page.getByRole('button', { name: 'סגירת החלון' })).toBeInViewport();
    });
  });
}

test.describe('Notification settings dialog on desktop', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('remains centered, compact, and fully visible -- unchanged from its existing placement', async ({ page }) => {
    const dialog = await openSettingsDialog(page);

    await expect(page.getByRole('heading', { name: 'הגדרות התראות' })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'סגירת החלון' })).toBeInViewport();
    await expect(page.getByText('עדכונים תפעוליים').first()).toBeInViewport();

    const panelBox = (await dialog.boundingBox())!;
    // Compact: a one-setting dialog must not stretch to fill the viewport.
    expect(panelBox.height).toBeLessThan(300);
    // Centered horizontally within the viewport (allowing a little slack).
    const viewportCenterX = 1280 / 2;
    const panelCenterX = panelBox.x + panelBox.width / 2;
    expect(Math.abs(panelCenterX - viewportCenterX)).toBeLessThan(5);

    expect(panelBox.y).toBeGreaterThanOrEqual(0);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(900);
  });
});
