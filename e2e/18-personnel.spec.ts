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

    await dialog.getByLabel('שם מלא', { exact: false }).fill('טכנאי E2E');
    await dialog.getByLabel('כתובת חשבון Google', { exact: false }).fill('e2e.tech@example.com');
    await dialog.getByRole('button', { name: 'הוספה' }).click();

    await expect(page.getByText(/איש הצוות נוסף וממתין להתחברות הראשונה/)).toBeVisible();
    await expect(page.getByText('טכנאי E2E')).toBeVisible();
    await expect(page.getByText('e2e.tech@example.com')).toBeVisible();
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

    // Bottom nav is capped at the first 4 destinations; כוח אדם is reached
    // via the mobile user menu, same pattern as other secondary destinations.
    await expect(page.getByRole('navigation', { name: 'ניווט תחתון' })).toBeVisible();
    await page.getByLabel('תפריט משתמש').click();
    await page.getByRole('link', { name: 'כוח אדם' }).click();
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

    const row = page.locator('.surface', { hasText: 'לעריכה נייד' });
    await row.getByRole('button', { name: 'עריכה' }).click();
    dialog = page.getByRole('dialog', { name: 'עריכת רישום ממתין' });
    const nameField = dialog.getByLabel('שם מלא', { exact: false });
    await nameField.fill('שם עודכן נייד');
    await dialog.getByRole('button', { name: 'שמירה' }).click();
    await expect(page.getByText('שם עודכן נייד')).toBeVisible();

    const updatedRow = page.locator('.surface', { hasText: 'שם עודכן נייד' });
    await updatedRow.getByRole('button', { name: 'ביטול' }).click();
    const confirm = page.getByRole('dialog', { name: 'ביטול רישום ממתין' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'ביטול הרישום' }).click();
    await expect(page.getByText('שם עודכן נייד')).toHaveCount(0);
  });
});
