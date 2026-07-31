// Regression coverage for: active-incidents filters silently failing to
// apply (severity, owner, and — since they all shared the same broken
// setFilters implementation — status/system/location too). Traces
// UI -> URL state -> query -> displayed results for each filter.
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test('severity filter changes the displayed results and the URL', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  await expect(page.getByRole('link', { name: /2026-001/ })).toBeVisible(); // critical
  await expect(page.getByRole('link', { name: /2026-004/ })).toBeVisible(); // low

  await page.getByLabel('סינון לפי חומרה').selectOption({ label: 'קריטית' });

  await expect(page).toHaveURL(/severity=critical/);
  await expect(page.getByRole('link', { name: /2026-001/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /2026-004/ })).toHaveCount(0);
});

test('owner/handler filter changes the displayed results and the URL', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  // inc-1 is owned by עומר פרץ, inc-2 by ליאור אדרי in the demo seed.
  await expect(page.getByRole('link', { name: /2026-001/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /2026-002/ })).toBeVisible();

  await page.getByLabel('סינון לפי גורם מטפל').selectOption({ label: 'עומר פרץ (דמו)' });

  await expect(page).toHaveURL(/owner=/);
  await expect(page.getByRole('link', { name: /2026-001/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /2026-002/ })).toHaveCount(0);
});

test('status filter changes the displayed results and the URL', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  await page.getByLabel('סינון לפי סטטוס').selectOption({ value: 'waiting_external' });

  await expect(page).toHaveURL(/status=waiting_external/);
  // inc-3 is the only waiting_external incident in the demo seed.
  await expect(page.getByRole('link', { name: /2026-003/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /2026-001/ })).toHaveCount(0);
});

test('system filter changes the displayed results and the URL', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/incidents');
  await page.getByLabel('סינון לפי מערכת').selectOption({ label: 'מערכת גמא' });

  await expect(page).toHaveURL(/system=/);
  await expect(page.getByRole('link', { name: /2026-003/ })).toBeVisible(); // sys-gamma
  await expect(page.getByRole('link', { name: /2026-001/ })).toHaveCount(0); // sys-alpha

  // Changing severity afterwards must not wipe out the system filter, and
  // vice versa -- this is exactly what the multi-call url.set() bug broke.
  // inc-3 and inc-7 are both מערכת גמא and severity "בינונית", so combining
  // both filters should still surface a real, non-empty result.
  await page.getByLabel('סינון לפי חומרה').selectOption({ label: 'בינונית' });
  await expect(page).toHaveURL(/system=/);
  await expect(page).toHaveURL(/severity=medium/);
  await expect(page.getByRole('link', { name: /2026-003/ })).toBeVisible();
});
