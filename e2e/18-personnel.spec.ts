// כוח אדם (personnel) page: navigation reachability, mobile bottom-sheet vs
// desktop dialog rendering, and the add/edit/cancel flow end to end.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test.describe('desktop', () => {
  test('shift_supervisor reaches כוח אדם via the sidebar and adds a technician', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.getByRole('navigation', { name: 'ניווט ראשי' }).getByRole('link', { name: 'כוח אדם' }).click();
    await expect(page.getByRole('heading', { name: 'כוח אדם' })).toBeVisible();

    await page.getByRole('button', { name: 'הוספת איש צוות' }).click();
    const dialog = page.getByRole('dialog', { name: 'הוספת איש צוות' });
    await expect(dialog).toBeVisible();
    // Centered dialog on desktop, not a bottom sheet: the panel does not
    // touch the bottom edge of the viewport.
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThan(viewport!.height - 4);

    // RTL button order: the primary "הוספה" action sits visually first
    // (rightmost), "ביטול" second -- both buttons live in the same row.
    const buttons = dialog.locator('form button');
    await expect(buttons.nth(0)).toHaveText('הוספה');
    await expect(buttons.nth(1)).toHaveText('ביטול');

    await dialog.getByLabel('שם מלא', { exact: false }).fill('טכנאי E2E');
    await dialog.getByLabel('כתובת חשבון Google', { exact: false }).fill('e2e.tech@example.com');
    await dialog.getByRole('button', { name: 'הוספה' }).click();

    await expect(page.getByText(/איש הצוות נוסף וממתין להתחברות הראשונה/)).toBeVisible();
    await expect(page.getByText('טכנאי E2E')).toBeVisible();
    await expect(page.getByText('e2e.tech@example.com')).toBeVisible();
  });

  test('a pending row matches the active/inactive row layout: initials avatar, prominent name, email below, no inline role label', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/personnel');

    await page.getByRole('button', { name: 'הוספת איש צוות' }).click();
    const dialog = page.getByRole('dialog', { name: 'הוספת איש צוות' });
    await dialog.getByLabel('שם מלא', { exact: false }).fill('טכנאי פריסה E2E');
    await dialog.getByLabel('כתובת חשבון Google', { exact: false }).fill('e2e.layout@example.com');
    await dialog.getByRole('button', { name: 'הוספה' }).click();
    await expect(page.getByText('טכנאי פריסה E2E')).toBeVisible();

    const row = page.locator('[data-personnel-row]', { hasText: 'טכנאי פריסה E2E' });

    // Initials avatar, never a photo -- unclaimed before first login.
    const avatar = row.locator('span[aria-hidden="true"]');
    await expect(avatar).toBeVisible();
    await expect(avatar).toHaveText('ט');
    await expect(avatar.locator('img')).toHaveCount(0);

    // Email sits directly under the name, same right edge.
    const nameBox = await row.getByText('טכנאי פריסה E2E').boundingBox();
    const emailBox = await row.getByText('e2e.layout@example.com').boundingBox();
    expect(nameBox).not.toBeNull();
    expect(emailBox).not.toBeNull();
    expect(Math.abs(emailBox!.x + emailBox!.width - (nameBox!.x + nameBox!.width))).toBeLessThan(4);
    expect(emailBox!.y).toBeGreaterThan(nameBox!.y);
    expect(emailBox!.y - (nameBox!.y + nameBox!.height)).toBeLessThan(12);

    // No redundant inline role label on the row -- shown once, on the group heading.
    await expect(page.getByRole('heading', { name: /^טכנאי/ })).toBeVisible();
    await expect(row.getByText('טכנאי', { exact: true })).toHaveCount(0);

    // Status badge and three-dot actions preserved, on the opposite side.
    await expect(row.getByText('ממתין להתחברות')).toBeVisible();
    await expect(row.getByRole('button', { name: /^פעולות עבור / })).toBeVisible();
  });

  test('the personnel list is compact: no permanently visible role select or deactivate button', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await page.goto('/personnel');
    await page.getByRole('tab', { name: /^פעילים/ }).click();

    const row = page.locator('[data-personnel-row]', { hasText: 'עומר פרץ' });
    await expect(row).toBeVisible();
    await expect(row.getByRole('combobox')).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'השבתה' })).toHaveCount(0);
    // Row actions now live behind a single overflow trigger rather than as
    // permanently visible buttons.
    await expect(row.getByRole('button', { name: 'עריכה' })).toHaveCount(0);
    const rowActions = row.getByRole('button', { name: /^פעולות עבור / });
    await expect(rowActions).toBeVisible();

    // Choosing עריכה from the menu reveals the role select and deactivate button.
    await rowActions.click();
    await row.getByRole('menu').getByRole('menuitem', { name: 'עריכה' }).click();
    await expect(row.getByRole('combobox')).toBeVisible();
    await expect(row.getByRole('button', { name: 'השבתה' })).toBeVisible();
  });

  test('a system_admin renames an active linked profile via שינוי שם; the new name and avatar initial update', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await page.goto('/personnel');
    await page.getByRole('tab', { name: /^פעילים/ }).click();

    const row = page.locator('[data-personnel-row]', { hasText: 'עומר פרץ' });
    await row.getByRole('button', { name: /^פעולות עבור / }).click();
    await row.getByRole('menu').getByRole('menuitem', { name: 'שינוי שם' }).click();

    const dialog = page.getByRole('dialog', { name: 'שינוי שם' });
    await expect(dialog).toBeVisible();
    const nameField = dialog.getByLabel('שם מלא', { exact: false });
    await expect(nameField).toHaveValue('עומר פרץ (דמו)');
    await nameField.fill('עומר פרץ המחודש');
    await dialog.getByRole('button', { name: 'שמירה' }).click();

    const renamedRow = page.locator('[data-personnel-row]', { hasText: 'עומר פרץ המחודש' });
    await expect(renamedRow).toBeVisible();
    // The avatar's initial letter fallback reflects the new name.
    await expect(renamedRow.locator('span[aria-hidden="true"]', { hasText: 'ע' })).toBeVisible();
  });

  test('the email sits directly under the name on the right, not floated over toward the status/menu side', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await page.goto('/personnel');

    // Demo-seeded profiles carry no Google email (linkedEmailOf resolves
    // only through a CLAIMED pending entry). Inject one directly into the
    // browser's demo localStorage database -- same shape claimPendingProfile
    // would have produced -- so this linked row has a real email to check
    // the layout against, exactly like a real claimed account would.
    await page.evaluate(() => {
      const key = 'takalot-demo-db-v1';
      const db = JSON.parse(localStorage.getItem(key)!);
      db.pendingPersonnel = db.pendingPersonnel || [];
      db.pendingPersonnel.push({
        id: 'e2e-email-position-check',
        fullName: 'עומר פרץ (דמו)',
        email: 'omer.peretz@example.com',
        role: 'technician',
        status: 'claimed',
        createdBy: 'u-admin',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: null,
        claimedBy: 'u-tech-1',
        claimedAt: new Date().toISOString(),
        cancelledBy: null,
        cancelledAt: null,
      });
      localStorage.setItem(key, JSON.stringify(db));
    });
    await page.goto('/personnel');
    await page.getByRole('tab', { name: /^פעילים/ }).click();

    const row = page.locator('[data-personnel-row]', { hasText: 'עומר פרץ' });
    const nameBox = await row.getByText('עומר פרץ (דמו)').boundingBox();
    const emailBox = await row.getByText('omer.peretz@example.com').boundingBox();
    const statusBox = await row.getByText('פעיל').boundingBox();
    expect(nameBox).not.toBeNull();
    expect(emailBox).not.toBeNull();
    expect(statusBox).not.toBeNull();
    // The email sits (nearly) flush with the name's right edge -- directly
    // below it in the identity block -- and well clear of (to the right
    // of) the status/menu block on the row's other side, not floated over
    // toward it.
    expect(Math.abs(emailBox!.x + emailBox!.width - (nameBox!.x + nameBox!.width))).toBeLessThan(4);
    expect(emailBox!.x).toBeGreaterThan(statusBox!.x + statusBox!.width);
  });

  test('a system_admin can rename THEMSELVES via שינוי שם on their own row, with no other self-service action offered', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await page.goto('/personnel');
    await page.getByRole('tab', { name: /^פעילים/ }).click();

    const ownRow = page.locator('[data-personnel-row]', { hasText: 'אלון ברק' });
    await expect(ownRow.getByText('אתה')).toBeVisible();
    const trigger = ownRow.getByRole('button', { name: /^פעולות עבור / });
    await trigger.click();
    const menu = ownRow.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveCount(1);
    await menu.getByRole('menuitem', { name: 'שינוי שם' }).click();

    const dialog = page.getByRole('dialog', { name: 'שינוי שם' });
    await dialog.getByLabel('שם מלא', { exact: false }).fill('אלון ברק המחודש');
    await dialog.getByRole('button', { name: 'שמירה' }).click();

    await expect(page.locator('[data-personnel-row]', { hasText: 'אלון ברק המחודש' })).toBeVisible();
  });

  test('technician does not see כוח אדם and is blocked from /personnel directly', async ({ page }) => {
    await loginAs(page, DEMO_USERS.tech1);
    await expect(page.getByRole('navigation', { name: 'ניווט ראשי' }).getByRole('link', { name: 'כוח אדם' })).toHaveCount(0);
    await page.goto('/personnel');
    await expect(page.getByText('אין הרשאה')).toBeVisible();
  });
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('shift_supervisor reaches כוח אדם from the mobile user menu; the add form opens as a bottom sheet', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);

    // כוח אדם is also reached via the mobile user menu (a secondary, redundant
    // entry point alongside the bottom nav) -- scope to the popover panel
    // since supervisor1 is authorized and the same link now also appears in
    // the bottom nav itself.
    await expect(page.getByRole('navigation', { name: 'ניווט תחתון' })).toBeVisible();
    await page.getByLabel('תפריט משתמש').click();
    await page.locator('.popover-panel').getByRole('link', { name: 'כוח אדם' }).click();
    await expect(page.getByRole('heading', { name: 'כוח אדם' })).toBeVisible();

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(391);

    await page.getByRole('button', { name: 'הוספת איש צוות' }).click();
    const dialog = page.getByRole('dialog', { name: 'הוספת איש צוות' });
    await expect(dialog).toBeVisible();
    // Bottom sheet on mobile: the panel's bottom edge sits at the viewport
    // edge (rounded top corners only, per the shared Dialog component).
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeGreaterThanOrEqual(844 - 4);

    await dialog.getByLabel('שם מלא', { exact: false }).fill('טכנאי נייד');
    await dialog.getByLabel('כתובת חשבון Google', { exact: false }).fill('mobile.tech@example.com');
    await dialog.getByRole('button', { name: 'הוספה' }).click();
    await expect(page.getByText('טכנאי נייד')).toBeVisible();
  });

  test('a pending row keeps the initials avatar and email-under-name layout at mobile width too, with no inline role label', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/personnel');

    await page.getByRole('button', { name: 'הוספת איש צוות' }).click();
    const dialog = page.getByRole('dialog', { name: 'הוספת איש צוות' });
    await dialog.getByLabel('שם מלא', { exact: false }).fill('טכנאי פריסה נייד');
    await dialog.getByLabel('כתובת חשבון Google', { exact: false }).fill('mobile.layout@example.com');
    await dialog.getByRole('button', { name: 'הוספה' }).click();
    await expect(page.getByText('טכנאי פריסה נייד')).toBeVisible();

    const row = page.locator('[data-personnel-row]', { hasText: 'טכנאי פריסה נייד' });

    const avatar = row.locator('span[aria-hidden="true"]');
    await expect(avatar).toBeVisible();
    await expect(avatar).toHaveText('ט');
    await expect(avatar.locator('img')).toHaveCount(0);

    const nameBox = await row.getByText('טכנאי פריסה נייד').boundingBox();
    const emailBox = await row.getByText('mobile.layout@example.com').boundingBox();
    expect(nameBox).not.toBeNull();
    expect(emailBox).not.toBeNull();
    expect(Math.abs(emailBox!.x + emailBox!.width - (nameBox!.x + nameBox!.width))).toBeLessThan(4);
    expect(emailBox!.y).toBeGreaterThan(nameBox!.y);
    expect(emailBox!.y - (nameBox!.y + nameBox!.height)).toBeLessThan(12);

    await expect(page.getByRole('heading', { name: /^טכנאי/ })).toBeVisible();
    await expect(row.getByText('טכנאי', { exact: true })).toHaveCount(0);

    await expect(row.getByText('ממתין להתחברות')).toBeVisible();
    await expect(row.getByRole('button', { name: /^פעולות עבור / })).toBeVisible();

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(391);
  });

  test('editing and cancelling a pending entry works at mobile width, with a confirmation step', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/personnel');

    await page.getByRole('button', { name: 'הוספת איש צוות' }).click();
    let dialog = page.getByRole('dialog', { name: 'הוספת איש צוות' });
    await dialog.getByLabel('שם מלא', { exact: false }).fill('לעריכה נייד');
    await dialog.getByLabel('כתובת חשבון Google', { exact: false }).fill('mobile.edit@example.com');
    await dialog.getByRole('button', { name: 'הוספה' }).click();
    await expect(page.getByText('לעריכה נייד')).toBeVisible();

    const row = page.locator('[data-personnel-row]', { hasText: 'לעריכה נייד' });
    await row.getByRole('button', { name: /^פעולות עבור / }).click();
    await row.getByRole('menu').getByRole('menuitem', { name: 'עריכה' }).click();
    dialog = page.getByRole('dialog', { name: 'עריכת רישום ממתין' });
    const nameField = dialog.getByLabel('שם מלא', { exact: false });
    await nameField.fill('שם עודכן נייד');
    await dialog.getByRole('button', { name: 'שמירה' }).click();
    await expect(page.getByText('שם עודכן נייד')).toBeVisible();

    const updatedRow = page.locator('[data-personnel-row]', { hasText: 'שם עודכן נייד' });
    await updatedRow.getByRole('button', { name: /^פעולות עבור / }).click();
    await updatedRow.getByRole('menu').getByRole('menuitem', { name: 'ביטול' }).click();
    const confirm = page.getByRole('dialog', { name: 'ביטול רישום ממתין' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'ביטול הרישום' }).click();
    await expect(page.getByText('שם עודכן נייד')).toHaveCount(0);
  });

  test('renaming a pending entry via שינוי שם works at mobile width, as a bottom sheet', async ({ page }) => {
    await loginAs(page, DEMO_USERS.supervisor1);
    await page.goto('/personnel');

    await page.getByRole('button', { name: 'הוספת איש צוות' }).click();
    let dialog = page.getByRole('dialog', { name: 'הוספת איש צוות' });
    await dialog.getByLabel('שם מלא', { exact: false }).fill('לשינוי שם נייד');
    await dialog.getByLabel('כתובת חשבון Google', { exact: false }).fill('mobile.rename@example.com');
    await dialog.getByRole('button', { name: 'הוספה' }).click();
    await expect(page.getByText('לשינוי שם נייד')).toBeVisible();

    const row = page.locator('[data-personnel-row]', { hasText: 'לשינוי שם נייד' });
    await row.getByRole('button', { name: /^פעולות עבור / }).click();
    await row.getByRole('menu').getByRole('menuitem', { name: 'שינוי שם' }).click();

    dialog = page.getByRole('dialog', { name: 'שינוי שם' });
    await expect(dialog).toBeVisible();
    // Bottom sheet on mobile, same as every other Dialog-based flow.
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeGreaterThanOrEqual(844 - 4);

    await dialog.getByLabel('שם מלא', { exact: false }).fill('שם שונה בנייד');
    await dialog.getByRole('button', { name: 'שמירה' }).click();
    await expect(page.getByText('שם שונה בנייד')).toBeVisible();
    await expect(page.getByText('לשינוי שם נייד')).toHaveCount(0);
  });

  test('the email sits directly under the name at mobile width too', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await page.goto('/personnel');
    await page.evaluate(() => {
      const key = 'takalot-demo-db-v1';
      const db = JSON.parse(localStorage.getItem(key)!);
      db.pendingPersonnel = db.pendingPersonnel || [];
      db.pendingPersonnel.push({
        id: 'e2e-email-position-check-mobile',
        fullName: 'עומר פרץ (דמו)',
        email: 'omer.peretz@example.com',
        role: 'technician',
        status: 'claimed',
        createdBy: 'u-admin',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: null,
        claimedBy: 'u-tech-1',
        claimedAt: new Date().toISOString(),
        cancelledBy: null,
        cancelledAt: null,
      });
      localStorage.setItem(key, JSON.stringify(db));
    });
    await page.goto('/personnel');
    await page.getByRole('tab', { name: /^פעילים/ }).click();

    const row = page.locator('[data-personnel-row]', { hasText: 'עומר פרץ' });
    const nameBox = await row.getByText('עומר פרץ (דמו)').boundingBox();
    const emailBox = await row.getByText('omer.peretz@example.com').boundingBox();
    expect(nameBox).not.toBeNull();
    expect(emailBox).not.toBeNull();
    // Directly below the name (same right edge, and just underneath it).
    expect(Math.abs(emailBox!.x + emailBox!.width - (nameBox!.x + nameBox!.width))).toBeLessThan(4);
    expect(emailBox!.y).toBeGreaterThan(nameBox!.y);
    expect(emailBox!.y - (nameBox!.y + nameBox!.height)).toBeLessThan(12);
  });
});
