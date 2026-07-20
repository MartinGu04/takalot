import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

// inc-1 (critical, overdue) is the accented card used throughout.
const INC1_IMPACT = 'אין יכולת הפעלה מלאה של מערכת אלפא. נדרש מעקף ידני.';

function urgentCard(page: import('@playwright/test').Page) {
  return page.locator('a.incident-card', { hasText: INC1_IMPACT });
}

test.describe('incident card content hierarchy', () => {
  test('number+severity on the first line, labeled system/location on the second, above the description', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const card = urgentCard(page);
    const numberLine = card.locator('span', { hasText: '2026-001' }).first().locator('..');
    await expect(numberLine).toContainText('קריטית'); // severity badge shares the first line
    const systemLocationLine = card.getByText(/מערכת:.*מיקום:/);
    await expect(systemLocationLine).toBeVisible();
    await expect(systemLocationLine).toContainText('מערכת אלפא');
    await expect(systemLocationLine).toContainText('אתר 1');

    const numberBox = await numberLine.boundingBox();
    const sysLocBox = await systemLocationLine.boundingBox();
    const descriptionBox = await card.getByText(INC1_IMPACT).boundingBox();
    expect(numberBox && sysLocBox && descriptionBox).toBeTruthy();
    if (numberBox && sysLocBox && descriptionBox) {
      expect(sysLocBox.y).toBeGreaterThan(numberBox.y);
      expect(descriptionBox.y).toBeGreaterThan(sysLocBox.y);
    }
  });

  test('closed/archive cards inherit the same header hierarchy', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await page.goto('/archive');
    const closedCard = page.locator('a.incident-card').first();
    await expect(closedCard.getByText(/מערכת:.*מיקום:/)).toBeVisible();
  });
});

test.describe('incident card structure', () => {
  test('desktop: metadata sits in a stable column beside the main content, not scattered across the card width', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, DEMO_USERS.admin);

    const card = urgentCard(page);
    const cardBox = await card.boundingBox();
    const statusBadge = card.getByText('בטיפול', { exact: true });
    const statusBox = await statusBadge.boundingBox();
    const description = card.getByText(INC1_IMPACT);
    const descriptionBox = await description.boundingBox();
    expect(cardBox && statusBox && descriptionBox).toBeTruthy();
    if (cardBox && statusBox && descriptionBox) {
      // Metadata (status) sits clearly to one side (the document is RTL, so
      // the metadata column renders to the LEFT of the main content), not
      // overlapping the description's horizontal range -- a real two-column split.
      expect(statusBox.x + statusBox.width).toBeLessThan(descriptionBox.x + 10);
    }
  });

  test('mobile: the card stacks vertically instead of forcing the desktop two-column split', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await loginAs(page, DEMO_USERS.admin);

    const card = urgentCard(page);
    const description = card.getByText(INC1_IMPACT);
    const statusBadge = card.getByText('בטיפול', { exact: true });
    const descriptionBox = await description.boundingBox();
    const statusBox = await statusBadge.boundingBox();
    expect(descriptionBox && statusBox).toBeTruthy();
    if (descriptionBox && statusBox) {
      // Metadata renders BELOW the main content on mobile, not beside it.
      expect(statusBox.y).toBeGreaterThan(descriptionBox.y + descriptionBox.height - 5);
    }

    const before = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(before).toBeLessThanOrEqual(390);
  });

  test('long system/handler names do not cause horizontal overflow on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await loginAs(page, DEMO_USERS.admin);
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflowX).toBe(false);
  });
});

test.describe('contextual affordance is keyboard-accessible', () => {
  test('the trailing chevron becomes visible on keyboard focus, not only on mouse hover', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const card = urgentCard(page);
    const chevron = card.locator('svg').first();
    await expect(chevron).toHaveCSS('opacity', '0');

    // Real keyboard navigation (Tab), not a scripted .focus() call, so the
    // browser actually sets the focus-visible flag Tailwind's
    // group-focus-visible: variant depends on -- inc-1 is the sole card in
    // "דורש טיפול עכשיו", immediately after the primary stat in tab order.
    await page.getByRole('button', { name: /תקלות פתוחות/ }).focus();
    await page.keyboard.press('Tab');
    await expect(card).toBeFocused();
    await expect(chevron).toHaveCSS('opacity', '1');
  });

  test('the card is reachable and activatable by keyboard alone', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const card = urgentCard(page);
    await card.focus();
    await expect(card).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/incidents\/inc-1/);
  });
});

test.describe('critical vs overdue accents are visually distinct', () => {
  test('the critical+overdue card gets the red critical treatment', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    const card = urgentCard(page);
    await expect(card).toHaveClass(/incident-card-accent-critical/);
    await expect(card).not.toHaveClass(/incident-card-accent-overdue/);
  });
});

test.describe('mobile stat labels wrap instead of truncating', () => {
  test('"עדכונים באיחור" and "קריטיות / גבוהות" render without an ellipsis at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await loginAs(page, DEMO_USERS.admin);
    for (const label of ['עדכונים באיחור', 'קריטיות / גבוהות']) {
      const el = page.getByText(label, { exact: true });
      await expect(el).toBeVisible();
      const overflow = await el.evaluate((node) => getComputedStyle(node).textOverflow);
      expect(overflow).not.toBe('ellipsis');
      const noClip = await el.evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
      expect(noClip).toBe(true);
    }
  });
});

test.describe('long handler name is accessible on desktop even when the column truncates it', () => {
  test('the handler name carries a title attribute with the full text', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, DEMO_USERS.admin);
    const card = urgentCard(page);
    const handler = card.getByText('עומר פרץ (דמו)', { exact: true });
    await expect(handler).toHaveAttribute('title', 'עומר פרץ (דמו)');
  });
});

test.describe('hover lifts modestly without scaling', () => {
  test('hover translates the card up a few pixels and does not scale it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, DEMO_USERS.admin);
    const card = urgentCard(page);
    const before = await card.boundingBox();
    await card.hover();
    await page.waitForTimeout(250); // let the 200ms transition finish
    const after = await card.boundingBox();
    expect(before && after).toBeTruthy();
    if (before && after) {
      expect(after.width).toBeCloseTo(before.width, 0); // no horizontal scale
      const lift = before.y - after.y;
      expect(lift).toBeGreaterThan(1);
      expect(lift).toBeLessThan(6);
    }
  });
});
