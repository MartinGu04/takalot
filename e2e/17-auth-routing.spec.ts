// Login-state routing and session lifecycle, exercised through the demo
// seam (the explicit development/test fallback -- the routing, guards, and
// session-restoration code paths are shared by both modes; only the
// identity provider behind them differs, and interactive Google UI is
// deliberately out of scope for CI).
import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

test('an unauthenticated visit to a protected route redirects to the login screen', async ({ page }) => {
  await page.goto('/incidents');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('brand-name')).toBeVisible();
});

test('deep links to protected routes redirect unauthenticated users too', async ({ page }) => {
  await page.goto('/incidents/new');
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login$/);
});

test('a persisted session survives reload and direct navigation without showing the login screen', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);

  // Direct navigation to a deep route with the persisted session.
  await page.goto('/incidents');
  await expect(page.getByRole('heading', { name: 'תקלות' })).toBeVisible();

  // Reload: the session restores and the app renders -- the URL must never
  // bounce through /login (which is what a login-page flash would be).
  await page.reload();
  await expect(page.getByRole('heading', { name: 'תקלות' })).toBeVisible();
  expect(page.url()).not.toContain('/login');
});

test('visiting /login while signed in redirects into the app', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'מצב נוכחי' })).toBeVisible();
  expect(page.url()).not.toContain('/login');
});

test('logout clears the session: back to login, protected routes redirect again, state is gone after reload', async ({ page }) => {
  await loginAs(page, DEMO_USERS.supervisor1);

  await page.getByRole('button', { name: 'התנתקות' }).click();
  await expect(page).toHaveURL(/\/login$/);

  // The cleared session must not resurrect on reload or direct navigation.
  await page.goto('/incidents');
  await expect(page).toHaveURL(/\/login$/);
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
});
