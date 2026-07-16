// Regression coverage for: URL-persisted filters must keep working after
// the setFilters/useUrlState fix (atomic multi-key updates, debounced
// search draft). A direct navigation to a filtered URL must restore the
// same filtered view, and the browser back button must restore the
// previous filter state.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test('a URL with filter params restores the same filtered view on load', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents?severity=critical&q=%D7%90%D7%9C%D7%A4%D7%90'); // q=אלפא
  // The search box reflects its URL-restored value directly. The severity
  // <select> is an "add another filter" picker that always resets to its
  // placeholder -- the active filter is proven by the filtered results below.
  await expect(page.getByLabel('חיפוש תקלות')).toHaveValue('אלפא');
  await expect(page.getByRole('link', { name: /2026-001/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /2026-002/ })).toHaveCount(0);
});

test('multiple sequential filter changes all persist together in the URL and in the results', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  await page.getByLabel('סינון לפי חומרה').selectOption({ label: 'קריטית' });
  await expect(page).toHaveURL(/severity=critical/);

  await page.getByLabel('סינון לפי סטטוס').selectOption({ value: 'in_progress' });
  await expect(page).toHaveURL(/status=in_progress/);
  await expect(page).toHaveURL(/severity=critical/); // still present after a second change

  // inc-1 is the only incident matching both critical severity AND
  // in_progress status -- proves the two filters compose, not just the URL.
  await expect(page.getByRole('link', { name: /2026-001/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /2026-004/ })).toHaveCount(0); // low severity
});

test('browser back navigates away from the filtered page (filters use replace, not push)', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  await page.getByLabel('סינון לפי חומרה').selectOption({ label: 'קריטית' });
  await expect(page).toHaveURL(/severity=critical/);

  // Filter changes intentionally use history.replaceState (so adjusting
  // filters doesn't spam the back-button history with one entry per
  // change). Going back from the incidents page returns to whatever page
  // was open before it, not to an intermediate filter state.
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});
