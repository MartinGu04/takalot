import { test, expect, type Page } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

async function openAdminTab(page: Page, tabName: 'מערכות / עמדות' | 'מיקומים') {
  await page.goto('/admin');
  await page.getByRole('tab', { name: tabName }).click();
}

/** Names of the cards inside ONE fixed-category section (found by its <h2>
 *  heading, "<label> (<count>)"), in DOM order. Ordering is scoped per
 *  category now, so every drag/order assertion must stay inside one
 *  section rather than reading the whole (multi-category) tab. */
function categoryCardNames(page: Page, categoryLabel: string) {
  const section = page.locator('section', { has: page.getByRole('heading', { name: new RegExp(`^${categoryLabel} \\(\\d+\\)$`) }) });
  return section.locator('article p.truncate').allTextContents();
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
  test('desktop: dragging a system row by its handle reorders it within its category and survives a reload', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await openAdminTab(page, 'מערכות / עמדות');

    // sys-beta ("מערכת בטא") and sys-pos-a ("עמדה א׳") are both seeded in
    // the "מערכות תחנה" (station_systems) category.
    const before = await categoryCardNames(page, 'מערכות תחנה');
    expect(before.indexOf('מערכת בטא')).toBeLessThan(before.indexOf('עמדה א׳'));

    await dragHandleBy(page, 'גרירה לשינוי סדר עבור מערכת בטא', 110);

    await expect(async () => {
      const order = await categoryCardNames(page, 'מערכות תחנה');
      expect(order.indexOf('עמדה א׳')).toBeLessThan(order.indexOf('מערכת בטא'));
    }).toPass();

    // Persists after a real page reload (not just client-side state).
    await page.reload();
    await page.getByRole('tab', { name: 'מערכות / עמדות' }).click();
    const afterReload = await categoryCardNames(page, 'מערכות תחנה');
    expect(afterReload.indexOf('עמדה א׳')).toBeLessThan(afterReload.indexOf('מערכת בטא'));
  });

  test('keyboard: reordering a location via the focused drag handle survives a reload', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await openAdminTab(page, 'מיקומים');

    // loc-1 ("אתר 1") and loc-control ("חדר בקרה ראשי") are both seeded in
    // "פנים יחידתי" (unit_internal).
    const before = await categoryCardNames(page, 'פנים יחידתי');
    expect(before.indexOf('אתר 1')).toBeLessThan(before.indexOf('חדר בקרה ראשי'));

    await keyboardDragHandle(page, 'גרירה לשינוי סדר עבור אתר 1', 'ArrowDown', 'drop');

    await expect(async () => {
      const order = await categoryCardNames(page, 'פנים יחידתי');
      expect(order.indexOf('חדר בקרה ראשי')).toBeLessThan(order.indexOf('אתר 1'));
    }).toPass();

    await page.reload();
    await page.getByRole('tab', { name: 'מיקומים' }).click();
    const afterReload = await categoryCardNames(page, 'פנים יחידתי');
    expect(afterReload.indexOf('חדר בקרה ראשי')).toBeLessThan(afterReload.indexOf('אתר 1'));
  });

  test('Escape cancels an in-progress keyboard drag and leaves the order untouched', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await openAdminTab(page, 'מיקומים');

    const before = await categoryCardNames(page, 'פנים יחידתי');

    await keyboardDragHandle(page, 'גרירה לשינוי סדר עבור אתר 1', 'ArrowDown', 'cancel');

    const after = await categoryCardNames(page, 'פנים יחידתי');
    expect(after).toEqual(before);
  });

  test('dragging cannot move a record into a different category, and its own category is unaffected by drags elsewhere', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await openAdminTab(page, 'מערכות / עמדות');

    // "מחשוב" (computing, מערכת גמא alone) and "תשתיות" (infrastructure,
    // עמדה ב׳ alone) each have exactly one member -- there is no drop
    // target for either to reorder against inside its own section, and
    // reordering the unrelated "מערכות תחנה" section must never touch them.
    const computingBefore = await categoryCardNames(page, 'מחשוב');
    const infraBefore = await categoryCardNames(page, 'תשתיות');

    await dragHandleBy(page, 'גרירה לשינוי סדר עבור מערכת בטא', 110);
    await expect(async () => {
      const order = await categoryCardNames(page, 'מערכות תחנה');
      expect(order.indexOf('עמדה א׳')).toBeLessThan(order.indexOf('מערכת בטא'));
    }).toPass();

    expect(await categoryCardNames(page, 'מחשוב')).toEqual(computingBefore);
    expect(await categoryCardNames(page, 'תשתיות')).toEqual(infraBefore);
  });

  test('existing rename/change-category/deactivate/delete actions remain functional after a drag, via the three-dot menu', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await openAdminTab(page, 'מיקומים');

    await dragHandleBy(page, 'גרירה לשינוי סדר עבור אתר 1', 110);
    await expect(async () => {
      const order = await categoryCardNames(page, 'פנים יחידתי');
      expect(order.indexOf('חדר בקרה ראשי')).toBeLessThan(order.indexOf('אתר 1'));
    }).toPass();

    // The old always-visible action row is gone.
    const card = page.locator('article', { has: page.getByText('אתר 3', { exact: true }) });
    await expect(card.getByRole('button', { name: 'שינוי שם' })).toHaveCount(0);

    await card.getByRole('button', { name: 'פעולות עבור אתר 3' }).click();
    await page.getByRole('menuitem', { name: 'שינוי שם' }).click();
    const dialog = page.getByRole('dialog', { name: 'שינוי שם מיקום' });
    const input = dialog.getByLabel(/^שם חדש/);
    await input.fill('אתר 3 (שונה)');
    await dialog.getByRole('button', { name: 'שמירת השם' }).click();
    await expect(page.getByText('אתר 3 (שונה)', { exact: true })).toBeVisible();

    const renamedCard = page.locator('article', { has: page.getByText('אתר 3 (שונה)', { exact: true }) });
    await renamedCard.getByRole('button', { name: 'פעולות עבור אתר 3 (שונה)' }).click();
    await page.getByRole('menuitem', { name: 'השבתה' }).click();
    await page.getByRole('dialog', { name: 'השבתת מיקום' }).getByRole('button', { name: 'השבתה' }).click();
    await expect(renamedCard.getByText('לא פעיל')).toBeVisible();

    // "שינוי סוג" moves the record to its destination section.
    await renamedCard.getByRole('button', { name: 'פעולות עבור אתר 3 (שונה)' }).click();
    await page.getByRole('menuitem', { name: 'שינוי סוג' }).click();
    const categoryDialog = page.getByRole('dialog', { name: 'שינוי סוג עבור אתר 3 (שונה)' });
    await categoryDialog.getByLabel(/^סוג חדש/).selectOption({ label: 'אחר' });
    await categoryDialog.getByRole('button', { name: 'שמירה' }).click();
    await expect(page.getByText('הסוג עודכן בהצלחה.')).toBeVisible();
    await expect(async () => {
      expect(await categoryCardNames(page, 'אחר')).toContain('אתר 3 (שונה)');
    }).toPass();
  });

  test('mobile viewport: drag handle still reorders and the page has no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, DEMO_USERS.admin);
    await openAdminTab(page, 'מיקומים');

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(391);

    await dragHandleBy(page, 'גרירה לשינוי סדר עבור אתר 1', 110);
    await expect(async () => {
      const order = await categoryCardNames(page, 'פנים יחידתי');
      expect(order.indexOf('חדר בקרה ראשי')).toBeLessThan(order.indexOf('אתר 1'));
    }).toPass();
  });

  test('a role without reference-data permission never reaches the drag handle or the actions menu', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await expect(page.getByRole('link', { name: 'ניהול' })).toHaveCount(0);

    await page.goto('/admin');
    await expect(page.getByText('אין הרשאה')).toBeVisible();
    await expect(page.getByRole('button', { name: /^גרירה לשינוי סדר/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^פעולות עבור/ })).toHaveCount(0);
  });
});
