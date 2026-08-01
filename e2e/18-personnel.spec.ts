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

  test('the personnel list is compact: role shown as text, no permanently visible role select or deactivate button', async ({ page }) => {
    await loginAs(page, DEMO_USERS.admin);
    await page.goto('/personnel');
    await page.getByRole('tab', { name: /^פעילים/ }).click();

    const row = page.locator('[data-personnel-row]', { hasText: 'עומר פרץ' });
    await expect(row).toBeVisible();
    await expect(row.getByText('סוג משתמש: טכנאי')).toBeVisible();
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

  test('a system_admin renames an active linked profile via שינוי שם; the new name, avatar initial and role line all update', async ({ page }) => {
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
    await expect(renamedRow.getByText('סוג משתמש: טכנאי')).toBeVisible();
    // The avatar's initial letter fallback reflects the new name.
    await expect(renamedRow.locator('span[aria-hidden="true"]', { hasText: 'ע' })).toBeVisible();
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
});
