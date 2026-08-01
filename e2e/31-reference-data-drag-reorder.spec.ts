import { test, expect, type Page } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

async function openAdminTab(page: Page, tabName: 'מערכות / עמדות' | 'מיקומים') {
  await page.goto('/admin');
  await page.getByRole('tab', { name: tabName }).click();
}

function cardNames(page: Page) {
  return page.locator('article h2').allTextContents();
}

/** Real pointer-based drag: press on the handle, move past the pointer
 *  sensor's activation distance in a few steps, then release -- exercises
 *  the same PointerSensor path a mouse or touch drag uses in a real browser. */
async function dragHandleBy(page: Page, handleName: string, deltaY: number) {
  const handle = page.getByRole('button', { name: handleName });
  const box = await handle.boundingBox();
  if (!box) throw new Error(`No bounding box for handle "${handleName}"`);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + deltaY, { steps: 12 });
  await page.mouse.up();
}

/** Waits for one rendered animation frame -- dnd-kit's keyboard sensor
 *  measures collision rects via requestAnimationFrame after pickup and after
 *  each arrow-key move, so firing the next key event immediately (with no
 *  gap) can race that measurement under CPU load and silently drop the
 *  move. A double rAF round-trip (the second one only scheduled once the
 *  first has actually painted) is a deterministic way to wait "until the
 *  browser has settled the last frame", instead of a fixed sleep duration. */
async function waitForAnimationFrame(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/**
 * Keyboard-driven drag via the sortable handle's own dnd-kit contract:
 * focus -> Space (pick up, confirmed by aria-pressed) -> arrow key (move,
 * with a settle frame before and after) -> Space to drop or Escape to
 * cancel (confirmed by aria-pressed clearing). Asserting each intermediate
 * state, rather than firing all four key events back-to-back, is what makes
 * this reliable under load: a key sent before dnd-kit has finished
 * processing the previous one is not guaranteed to register.
 */
async function keyboardDragHandle(
  page: Page,
  handleName: string,
  direction: 'ArrowDown' | 'ArrowUp',
  end: 'drop' | 'cancel',
) {
  const handle = page.getByRole('button', { name: handleName });
  await handle.focus();
  await expect(handle).toBeFocused();

  await page.keyboard.press('Space');
  await expect(handle).toHaveAttribute('aria-pressed', 'true');

  await waitForAnimationFrame(page);
  await page.keyboard.press(direction);
  await waitForAnimationFrame(page);

  await page.keyboard.press(end === 'drop' ? 'Space' : 'Escape');
  await expect(handle).not.toHaveAttribute('aria-pressed', 'true');
}

test.describe('reference-data drag-and-drop reordering', () => {
  test('desktop: dragging a system row by its handle reorders it and survives a reload', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await openAdminTab(page, 'מערכות / עמדות');

    const before = await cardNames(page);
    expect(before.indexOf('מערכת אלפא')).toBeLessThan(before.indexOf('מערכת בטא'));

    await dragHandleBy(page, 'גרירה לשינוי סדר עבור מערכת בטא', -110);

    await expect(async () => {
      const order = await cardNames(page);
      expect(order.indexOf('מערכת בטא')).toBeLessThan(order.indexOf('מערכת אלפא'));
    }).toPass();

    // Persists after a real page reload (not just client-side state).
    await page.reload();
    await page.getByRole('tab', { name: 'מערכות / עמדות' }).click();
    const afterReload = await cardNames(page);
    expect(afterReload.indexOf('מערכת בטא')).toBeLessThan(afterReload.indexOf('מערכת אלפא'));
  });

  test('keyboard: reordering a location via the focused drag handle survives a reload', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await openAdminTab(page, 'מיקומים');

    const before = await cardNames(page);
    expect(before.indexOf('אתר 1')).toBeLessThan(before.indexOf('אתר 2'));

    await keyboardDragHandle(page, 'גרירה לשינוי סדר עבור אתר 1', 'ArrowDown', 'drop');

    await expect(async () => {
      const order = await cardNames(page);
      expect(order.indexOf('אתר 2')).toBeLessThan(order.indexOf('אתר 1'));
    }).toPass();
    await expect(page.getByText('סדר תצוגה: 2').first()).toBeVisible();

    await page.reload();
    await page.getByRole('tab', { name: 'מיקומים' }).click();
    const afterReload = await cardNames(page);
    expect(afterReload.indexOf('אתר 2')).toBeLessThan(afterReload.indexOf('אתר 1'));
  });

  test('Escape cancels an in-progress keyboard drag and leaves the order untouched', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await openAdminTab(page, 'מיקומים');

    const before = await cardNames(page);

    await keyboardDragHandle(page, 'גרירה לשינוי סדר עבור אתר 1', 'ArrowDown', 'cancel');

    const after = await cardNames(page);
    expect(after).toEqual(before);
  });

  test('existing rename/deactivate/delete row actions remain functional after a drag', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await openAdminTab(page, 'מיקומים');

    await dragHandleBy(page, 'גרירה לשינוי סדר עבור אתר 1', 110);
    await expect(async () => {
      const order = await cardNames(page);
      expect(order.indexOf('אתר 2')).toBeLessThan(order.indexOf('אתר 1'));
    }).toPass();

    const card = page.locator('article', { has: page.getByRole('heading', { name: 'אתר 3' }) });
    await card.getByRole('button', { name: 'שינוי שם' }).click();
    const dialog = page.getByRole('dialog', { name: 'שינוי שם מיקום' });
    const input = dialog.getByLabel(/^שם חדש/);
    await input.fill('אתר 3 (שונה)');
    await dialog.getByRole('button', { name: 'שמירת השם' }).click();
    await expect(page.getByRole('heading', { name: 'אתר 3 (שונה)' })).toBeVisible();

    const renamedCard = page.locator('article', { has: page.getByRole('heading', { name: 'אתר 3 (שונה)' }) });
    await renamedCard.getByRole('button', { name: 'השבתה' }).click();
    await page.getByRole('dialog', { name: 'השבתת מיקום' }).getByRole('button', { name: 'השבתה' }).click();
    await expect(renamedCard.getByText('לא פעיל')).toBeVisible();
  });

  test('mobile viewport: drag handle still reorders and the page has no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, DEMO_USERS.admin);
    await openAdminTab(page, 'מיקומים');

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(391);

    // Rows stack vertically at mobile width (flex-col until the lg: breakpoint),
    // so each card is much taller here than on desktop -- a bigger delta is
    // needed to cross into the next card's collision zone.
    await dragHandleBy(page, 'גרירה לשינוי סדר עבור אתר 1', 260);
    await expect(async () => {
      const order = await cardNames(page);
      expect(order.indexOf('אתר 2')).toBeLessThan(order.indexOf('אתר 1'));
    }).toPass();
  });

  test('a role without reference-data permission never reaches the drag handle', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await expect(page.getByRole('link', { name: 'ניהול' })).toHaveCount(0);

    await page.goto('/admin');
    await expect(page.getByText('אין הרשאה')).toBeVisible();
    await expect(page.getByRole('button', { name: /^גרירה לשינוי סדר/ })).toHaveCount(0);
  });
});
