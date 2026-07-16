import { expect, type Locator, type Page } from '@playwright/test';
import { DEMO_USERS } from '../src/data/local/seed';

export { DEMO_USERS };

export async function loginAs(page: Page, userId: string) {
  await page.goto('/login');
  await page.getByTestId(`login-${userId}`).click();
  await expect(page.getByRole('heading', { name: 'מצב נוכחי' })).toBeVisible();
}

/**
 * Types Hebrew text one character at a time via CDP insertText (Playwright's
 * `type()`/`pressSequentially()` map non-Latin characters through the US
 * keyboard layout and can hang or drop them). Asserts focus is retained
 * after every character — this is what a regression here looks like:
 * without it, the field remounts or the committed value snaps back to
 * empty mid-word.
 */
export async function typeAndCheckFocus(page: Page, locator: Locator, text: string) {
  await locator.click();
  for (const ch of text) {
    await page.keyboard.insertText(ch);
    await expect(locator).toBeFocused();
  }
}
