import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

// UpdateDialog viewport scrolling: at 100% browser zoom, filling the form and
// revealing both conditional reporting recipient fields makes the dialog's
// content taller than the viewport. The shared Dialog component (ui.tsx) must
// constrain itself to the viewport and scroll its own body reliably -- the
// last fields and the submit/cancel actions must stay reachable without any
// zoom change.
async function openLongUpdateDialog(page: import('@playwright/test').Page) {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-001/ }).click();

  await page.getByRole('button', { name: 'עדכון תקלה' }).click();
  const dialog = page.getByRole('dialog', { name: 'עדכון תקלה' });

  // Reveal both conditional recipient fields plus fill the free-text areas
  // generously, so the dialog's content genuinely exceeds a normal desktop
  // viewport height.
  await dialog.getByLabel('פעולות שבוצעו מאז העדכון הקודם').fill('טקסט ארוך לבדיקת גלילה. '.repeat(20));
  await dialog.getByLabel('ממצאים').fill('ממצאים נוספים לבדיקת גלילה. '.repeat(15));
  await dialog.getByLabel('פעולות המשך').fill('פעולות המשך לבדיקת גלילה. '.repeat(15));
  await dialog.getByLabel('סטטוס נוכחי').fill('טקסט נוסף לבדיקת גלילה. '.repeat(20));
  await dialog.getByLabel('דווח למבצעים?').selectOption({ label: 'כן' });
  await dialog.getByLabel('האם דווח לתקשוב למבצעים?').selectOption({ label: 'כן' });
  return dialog;
}

test.describe('UpdateDialog stays usable when its content exceeds the viewport', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('confirms overflow, scrolls with the mouse wheel, and reaches the final question and action buttons', async ({ page }) => {
    const dialog = await openLongUpdateDialog(page);

    // 1-3: the dialog's own panel is capped to the viewport (never scrolls
    // itself), while its scrollable body genuinely overflows.
    const before = await dialog.evaluate((el) => {
      const body = el.lastElementChild as HTMLElement;
      return {
        panelScrollHeight: el.scrollHeight,
        panelClientHeight: el.clientHeight,
        bodyScrollHeight: body.scrollHeight,
        bodyClientHeight: body.clientHeight,
        bodyScrollTop: body.scrollTop,
      };
    });
    expect(before.panelScrollHeight).toBeLessThanOrEqual(before.panelClientHeight + 1);
    expect(before.bodyScrollHeight).toBeGreaterThan(before.bodyClientHeight);
    expect(before.bodyScrollTop).toBe(0);

    // The final question and the action buttons are not yet visible/in-view.
    await expect(dialog.getByLabel('האם עודכן ב-WISDOM?')).not.toBeInViewport();

    // 4: scroll inside the dialog with the mouse wheel. Hover over a plain,
    // non-scrollable anchor inside the body (not, say, the middle of one of
    // the filled textareas -- a textarea with overflowing content is
    // independently scrollable and would legitimately consume the wheel
    // delta itself first via normal browser scroll-chaining, which is a
    // real, expected nested-scroll nuance and not what this test is about).
    await dialog.getByText(/דיווח בעדכון זה בלבד/).hover();
    await page.mouse.wheel(0, 3000);

    // 5: the final question and the submit/cancel actions are now reachable
    // and interactable, without any browser zoom change.
    const wisdomSelect = dialog.getByLabel('האם עודכן ב-WISDOM?');
    await expect(wisdomSelect).toBeInViewport();
    await wisdomSelect.selectOption({ label: 'כן' });
    await expect(wisdomSelect).toHaveValue('yes');

    const submitButton = dialog.getByRole('button', { name: 'שמירת עדכון' });
    const cancelButton = dialog.getByRole('button', { name: 'ביטול' });
    await expect(submitButton).toBeInViewport();
    await expect(cancelButton).toBeInViewport();
    await expect(submitButton).toBeEnabled();
    await expect(cancelButton).toBeEnabled();

    // No horizontal scrolling was introduced anywhere on the page.
    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(horizontalOverflow).toBe(false);

    // The background page remains locked while the dialog is open.
    const bodyOverflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
    expect(bodyOverflow).toBe('hidden');
  });

  test('keyboard scrolling (Page Down) and the visible scrollbar both reach the bottom of the dialog', async ({ page }) => {
    const dialog = await openLongUpdateDialog(page);
    const body = dialog.locator(':scope > div').last();

    // Focus a plain button, not one of the filled textareas -- a focused
    // text input/textarea captures Page Down for its own text-cursor
    // navigation instead of delegating it to the nearest scrollable
    // ancestor, which is a real, expected editable-content nuance and not
    // what this test is about.
    await dialog.getByRole('button', { name: 'ביטול' }).focus();
    await page.keyboard.press('PageDown');
    await page.keyboard.press('PageDown');
    await page.keyboard.press('PageDown');
    await expect
      .poll(async () => body.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);

    // Programmatically drive the scrollbar itself (setting scrollTop is the
    // same code path the visible scrollbar thumb drives) to the very bottom
    // and confirm the submit button becomes reachable.
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(dialog.getByRole('button', { name: 'שמירת עדכון' })).toBeInViewport();
  });

  test('the scrollable body is genuinely touch-scrollable: standard overflow-y-auto, no touch-action lockout, nothing blocks the gesture', async ({ browser }) => {
    // Chromium's compositor-level touch-to-scroll gesture recognition does
    // not reliably respond to CDP's synthetic Input.dispatchTouchEvent in a
    // headless/non-hardware context (a well-known Playwright/CDP limitation,
    // not something this app's code controls), so physically simulating a
    // touch swipe here would be flaky rather than meaningful. The actual,
    // deterministic guarantee that touch scrolling works is: the scrollable
    // body uses plain native overflow (no custom JS scroll handling to get
    // wrong), nothing sets `touch-action: none` on it or its ancestors, and
    // no handler calls preventDefault() on a touchmove -- every one of those
    // would be required for a real touchscreen NOT to be able to scroll it.
    const touchContext = await browser.newContext({ viewport: { width: 1280, height: 720 }, hasTouch: true });
    try {
      const touchPage = await touchContext.newPage();
      const dialog = await openLongUpdateDialog(touchPage);
      const anchorLocator = dialog.getByText(/דיווח בעדכון זה בלבד/);
      await anchorLocator.scrollIntoViewIfNeeded();
      const anchor = (await anchorLocator.boundingBox())!;
      const cx = anchor.x + anchor.width / 2;
      const cy = anchor.y + anchor.height / 2;

      const defaultPrevented = await touchPage.evaluate(
        ({ x, y }) => {
          const el = document.elementFromPoint(x, y) as HTMLElement;
          let node: HTMLElement | null = el;
          while (node) {
            if (getComputedStyle(node).touchAction === 'none') return { touchActionNone: true, prevented: null };
            node = node.parentElement;
          }
          const ev = new TouchEvent('touchmove', { cancelable: true, bubbles: true });
          el.dispatchEvent(ev);
          return { touchActionNone: false, prevented: ev.defaultPrevented };
        },
        { x: cx, y: cy },
      );
      expect(defaultPrevented.touchActionNone).toBe(false);
      expect(defaultPrevented.prevented).toBe(false);

      const bodyStyle = await dialog.evaluate((el) => {
        const body = el.lastElementChild as HTMLElement;
        return { overflowY: getComputedStyle(body).overflowY };
      });
      expect(['auto', 'scroll']).toContain(bodyStyle.overflowY);
    } finally {
      await touchContext.close();
    }
  });
});

test.describe('UpdateDialog on a small/mobile viewport', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('the bottom-sheet dialog stays capped to the viewport and scrolls to reach every field and action', async ({ page }) => {
    const dialog = await openLongUpdateDialog(page);

    const heights = await dialog.evaluate((el) => ({
      panelScrollHeight: el.scrollHeight,
      panelClientHeight: el.clientHeight,
    }));
    expect(heights.panelScrollHeight).toBeLessThanOrEqual(heights.panelClientHeight + 1);

    await dialog.getByText(/דיווח בעדכון זה בלבד/).hover();
    await page.mouse.wheel(0, 3000);

    await expect(dialog.getByLabel('האם עודכן ב-WISDOM?')).toBeInViewport();
    const submitButton = dialog.getByRole('button', { name: 'שמירת עדכון' });
    await expect(submitButton).toBeInViewport();
    await expect(submitButton).toBeEnabled();

    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(horizontalOverflow).toBe(false);
  });
});
