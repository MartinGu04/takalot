import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

// Regression coverage for the notification-filtering change: listNotifications
// now excludes historical 'update_overdue' rows (unit/repository-level
// coverage lives in localRepository.test.ts / supabaseRepository.test.ts,
// since there is no active product flow left that creates one to inject
// through the real UI). This spec proves the ordinary notification bell,
// badge, and panel still work correctly end to end for a ordinary
// (non-legacy) unread notification after that change.
test('notification badge and panel reflect a real unread notification, and reading it clears the badge', async ({ page }) => {
  await loginAs(page, DEMO_USERS.tech1);

  // tech1 has exactly one seeded unread notification (ntf-2, incident_assigned).
  const bellButton = page.getByTestId('notifications-button');
  await expect(bellButton).toHaveAccessibleName(/התראות \(1 שלא נקראו\)/);

  await bellButton.click();
  // The popover panel is portaled to document.body, sibling to the page root,
  // so a DOM-ancestor walk from the "התראות" heading lands on its own header
  // row rather than the panel that also contains the notification buttons.
  // Scope against the panel's own class instead.
  const panel = page.locator('.popover-panel');
  await expect(panel.getByText('תקלה הוקצתה אליך')).toBeVisible();
  await expect(panel.getByText(/הוקצתה אליך לאחר פתיחה מחדש/)).toBeVisible();

  await panel.getByText(/הוקצתה אליך לאחר פתיחה מחדש/).click();

  // Reading it (via navigation, which marks it read) clears the badge.
  await expect(bellButton).toHaveAccessibleName('התראות');
});
