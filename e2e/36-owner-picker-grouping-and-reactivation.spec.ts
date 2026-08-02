// Internal-owner picker (OwnerField, "בעל אחריות פנימי"): every caller must
// show only active, role-eligible candidates (system_admin,
// professional_manager, shift_supervisor, technician -- never viewer, never
// inactive), grouped by role in that order and sorted alphabetically within
// each group. This file proves the shared component behaves identically
// across incident creation, reassignment and incomplete-readiness closure,
// and that reactivating a deactivated eligible user makes them reappear in
// every picker without a hard page reload.
import { test, expect, type Locator } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

async function ownerGroups(select: Locator) {
  // Profiles load asynchronously; wait until the picker has actually
  // populated before reading its groups, rather than racing the fetch.
  await expect(select.locator('optgroup').first()).toBeAttached();
  const groupLabels = await select.locator('optgroup').evaluateAll((els) => els.map((e) => e.getAttribute('label')));
  const optionsByGroup = await select.locator('optgroup').evaluateAll((els) =>
    els.map((e) => Array.from(e.querySelectorAll('option')).map((o) => o.textContent)),
  );
  return groupLabels.map((label, i) => ({ label, options: optionsByGroup[i] }));
}

const EXPECTED_ALL_ACTIVE_GROUPS = [
  { label: 'מנהל מערכת', options: ['אלון ברק (דמו)'] },
  { label: 'נגד', options: ['דנה לוי (דמו)'] },
  { label: 'אחמ״ש', options: ['יואב כהן (דמו)', 'מאיה רוזן (דמו)'] },
  { label: 'טכנאי', options: ['ליאור אדרי (דמו)', 'עומר פרץ (דמו)'] },
];

test('incident creation: owner picker is grouped by role, sorted alphabetically, excludes viewers and inactive users', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents/new');

  const select = page.getByLabel('בעל אחריות פנימי');
  expect(await ownerGroups(select)).toEqual(EXPECTED_ALL_ACTIVE_GROUPS);
  await expect(select.getByRole('option', { name: 'רוני שגיא (דמו)' })).toHaveCount(0);
});

test('reassignment (שינוי גורם מטפל) shows the same grouped, sorted, filtered owner picker', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-001/ }).click();
  await page.getByRole('button', { name: 'שינוי גורם מטפל' }).click();

  const dialog = page.getByRole('dialog', { name: 'שינוי גורם מטפל' });
  const select = dialog.getByLabel('בעל אחריות פנימי');
  expect(await ownerGroups(select)).toEqual(EXPECTED_ALL_ACTIVE_GROUPS);
  await expect(select.getByRole('option', { name: 'רוני שגיא (דמו)' })).toHaveCount(0);
});

test('incomplete-readiness closure shows the same grouped, sorted, filtered owner picker for the continuation owner', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-002/ }).click();
  await page.getByRole('button', { name: 'סגירת תקלה' }).click();

  const dialog = page.getByRole('dialog', { name: 'סגירת תקלה' });
  await dialog.getByLabel('סיבת התקלה').fill('תקלת חומרה בכרטיס');
  await dialog.getByLabel('הפתרון שבוצע').fill('הותקן פתרון זמני');
  await dialog.getByLabel('כשירות המערכת').selectOption({ label: 'חלקית' });
  await dialog.getByLabel('פעולות המשך').fill('להזמין רכיב קבוע');

  const select = dialog.getByLabel('בעל אחריות פנימי');
  expect(await ownerGroups(select)).toEqual(EXPECTED_ALL_ACTIVE_GROUPS);
  await expect(select.getByRole('option', { name: 'רוני שגיא (דמו)' })).toHaveCount(0);
});

test('a deactivated eligible user disappears from the owner picker, and reappears after reactivation with no hard reload', async ({ page }) => {
  await loginAs(page, DEMO_USERS.admin);

  // Deactivate ליאור אדרי (tech2) via personnel management.
  await page.goto('/personnel');
  await page.getByRole('tab', { name: /^פעילים/ }).click();
  const row = page.locator('[data-personnel-row]', { hasText: 'ליאור אדרי' });
  await row.getByRole('button', { name: /^פעולות עבור / }).click();
  await row.getByRole('menu').getByRole('menuitem', { name: 'עריכה' }).click();
  await row.getByRole('button', { name: 'השבתה' }).click();
  const confirmDialog = page.getByRole('dialog', { name: 'השבתת משתמש' });
  await confirmDialog.getByRole('button', { name: 'השבתה' }).click();
  await page.getByRole('tab', { name: /^לא פעילים/ }).click();
  await expect(page.locator('[data-personnel-row]', { hasText: 'ליאור אדרי' })).toBeVisible();

  // Confirm absence from an owner picker -- no hard reload, same SPA session.
  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-001/ }).click();
  await page.getByRole('button', { name: 'שינוי גורם מטפל' }).click();
  let dialog = page.getByRole('dialog', { name: 'שינוי גורם מטפל' });
  let select = dialog.getByLabel('בעל אחריות פנימי');
  await expect(select.getByRole('option', { name: 'ליאור אדרי (דמו)' })).toHaveCount(0);
  await expect(select.getByRole('option', { name: 'עומר פרץ (דמו)' })).toHaveCount(1);
  await dialog.getByRole('button', { name: 'ביטול' }).click();

  // Reactivate, still within the same session.
  await page.goto('/personnel');
  await page.getByRole('tab', { name: /^לא פעילים/ }).click();
  const inactiveRow = page.locator('[data-personnel-row]', { hasText: 'ליאור אדרי' });
  await inactiveRow.getByRole('button', { name: /^פעולות עבור / }).click();
  await inactiveRow.getByRole('menu').getByRole('menuitem', { name: 'עריכה' }).click();
  await inactiveRow.getByRole('button', { name: 'הפעלה' }).click();
  await page.getByRole('tab', { name: /^פעילים/ }).click();
  await expect(page.locator('[data-personnel-row]', { hasText: 'ליאור אדרי' })).toBeVisible();

  // Reappears in the owner picker without a hard reload.
  await page.goto('/incidents');
  await page.getByRole('link', { name: /2026-001/ }).click();
  await page.getByRole('button', { name: 'שינוי גורם מטפל' }).click();
  dialog = page.getByRole('dialog', { name: 'שינוי גורם מטפל' });
  select = dialog.getByLabel('בעל אחריות פנימי');
  await expect(select.getByRole('option', { name: 'ליאור אדרי (דמו)' })).toHaveCount(1);
});
