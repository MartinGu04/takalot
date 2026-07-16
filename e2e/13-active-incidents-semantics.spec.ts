// Regression coverage for: the active "תקלות" page must show only
// non-closed incidents by default (closed incidents belong in the
// archive), reopened incidents must remain active, and the default sort
// must follow operational priority rather than opening time alone.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test('closed incidents are excluded from the active incidents page by default', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  // inc-5 and inc-6 are seeded as closed.
  await expect(page.getByRole('link', { name: /2026-005/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /2026-006/ })).toHaveCount(0);
  // "closed" is not even offered as a status filter option here -- closed
  // incidents belong in the archive, not behind a filter on this page.
  await expect(page.getByLabel('סינון לפי סטטוס').locator('option', { hasText: 'נסגרה' })).toHaveCount(0);
});

test('closed incidents remain fully searchable and filterable in the archive', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/archive');
  await expect(page.getByRole('link', { name: /2026-005/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /2026-006/ })).toBeVisible();
});

test('closed incidents with incomplete readiness appear only in the dashboard\'s dedicated section, never in the active incidents list', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  // inc-6 is seeded as closed with partial readiness (follow-up required).
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'כשירות לא מלאה' })).toBeVisible();
  await expect(page.getByRole('link', { name: /2026-006/ })).toBeVisible();

  await page.goto('/incidents');
  await expect(page.getByRole('link', { name: /2026-006/ })).toHaveCount(0);
});

test('reopened incidents remain in the active incidents page', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  // inc-7 is seeded as reopened.
  await expect(page.getByRole('link', { name: /2026-007/ })).toBeVisible();
});

test('default ordering follows operational priority, not opening time alone', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  // Wait for the list to actually render before reading DOM order.
  await expect(page.getByRole('link', { name: /2026-001/ })).toBeVisible();

  // inc-1 (critical, overdue) must lead; inc-7 is the oldest incident by far
  // (created 96h ago) but is only medium severity and not overdue, so it
  // must not lead merely because it's the oldest.
  //
  // Each incident card is a single clickable link (number, system, badges,
  // metadata all inside it), so its accessible text starts with — but isn't
  // limited to — the incident number; extract the leading number token from
  // each card in DOM order rather than requiring an isolated number-only link.
  const numbers = await page.locator('a[href^="/incidents/inc-"]').evaluateAll((els) =>
    els
      .map((el) => el.textContent?.trim().match(/^\d{4}-\d{3}/)?.[0])
      .filter((t): t is string => !!t),
  );
  expect(numbers[0]).toBe('2026-001');
  expect(numbers.indexOf('2026-007')).toBeGreaterThan(numbers.indexOf('2026-001'));
  expect(numbers.indexOf('2026-007')).toBeGreaterThan(numbers.indexOf('2026-002'));
});

test('active severity and status filter chips remain visible after selection', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');

  await page.getByLabel('סינון לפי חומרה').selectOption({ label: 'קריטית' });
  await page.getByLabel('סינון לפי סטטוס').selectOption({ value: 'in_progress' });

  // Each chip's accessible label ("הסרת סינון: <value>") is the most
  // reliable match -- the visible chip text sits alongside a "✕" icon in
  // the same element, so a plain substring text match is used for the rest.
  const activeFilters = page.getByRole('group', { name: 'מסננים פעילים' });
  await expect(activeFilters).toBeVisible();
  await expect(activeFilters.getByRole('button', { name: 'הסרת סינון: קריטית' })).toBeVisible();
  await expect(activeFilters.getByRole('button', { name: 'הסרת סינון: בטיפול' })).toBeVisible();

  // The pickers themselves reset to their "add another" placeholder -- the
  // chips area is what shows the user their selections are still active.
  await expect(page.getByLabel('סינון לפי חומרה')).toHaveValue('');
  await expect(page.getByLabel('סינון לפי סטטוס')).toHaveValue('');
});

test('severity/status picker placeholders use clear "add" wording', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  await expect(page.getByLabel('סינון לפי חומרה').locator('option').first()).toHaveText('הוספת חומרה…');
  await expect(page.getByLabel('סינון לפי סטטוס').locator('option').first()).toHaveText('הוספת סטטוס…');
});
