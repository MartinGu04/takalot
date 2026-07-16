import { expect, type Page } from '@playwright/test';
import { DEMO_USERS } from '../src/data/local/seed';

export { DEMO_USERS };

export async function loginAs(page: Page, userId: string) {
  await page.goto('/login');
  await page.getByTestId(`login-${userId}`).click();
  await expect(page.getByRole('heading', { name: 'מצב נוכחי' })).toBeVisible();
}
