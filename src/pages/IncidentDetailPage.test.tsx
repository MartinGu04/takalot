// UpdateDialog's status-target dropdown: exercised through the real app
// with the demo repository (real seeded incidents, real rules) -- not a UI
// mock. Chapter 2 frontend compatibility: cancelled/waiting_equipment/
// waiting_information/waiting_validation must be fully readable/renderable,
// but must NOT appear as a selectable update target yet -- closed/reopened
// for the long-standing dedicated-flow reason, cancelled for the same reason
// once its own dedicated flow ships, and the three waiting_* statuses
// because the backend's is_valid_transition (migration 0017) does not yet
// allow transitioning into any of them from any status.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type AppType from '../App';

let App: typeof AppType;
beforeEach(async () => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
  vi.resetModules();
  App = (await import('../App')).default;
});

function main(): HTMLElement {
  return document.querySelector('main') as HTMLElement;
}

const INC1_TEXT = /אין יכולת הפעלה מלאה של מערכת אלפא/;

// inc-1 (seed.ts): critical, in_progress, owned by tech1 -- open, so the
// system_admin demo user has full_update capability and the button renders.
// Demo login always redirects to '/' (LoginPage.tsx), so the incident detail
// page must be reached via a real link click from the dashboard, exactly
// like DashboardPage.test.tsx does -- not by pre-seeding the URL.
async function openUpdateDialogAsAdmin() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByTestId('login-u-admin'));
  const card = await within(main()).findByText(INC1_TEXT);
  await user.click(card.closest('a.incident-card') as HTMLElement);
  await user.click(await within(main()).findByRole('button', { name: 'עדכון תקלה' }));
  const statusSelect = await screen.findByRole('combobox', { name: /סטטוס נוכחי/ });
  return { user, statusSelect };
}

describe('UpdateDialog status dropdown: pre-cutover target exclusion', () => {
  it('does not offer cancelled or the three not-yet-reachable waiting_* statuses as a new selection', async () => {
    const { statusSelect } = await openUpdateDialogAsAdmin();
    const optionValues = within(statusSelect)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(optionValues).not.toContain('cancelled');
    expect(optionValues).not.toContain('waiting_equipment');
    expect(optionValues).not.toContain('waiting_information');
    expect(optionValues).not.toContain('waiting_validation');
  });

  it('still excludes closed and reopened (long-standing dedicated-flow rule, unchanged)', async () => {
    const { statusSelect } = await openUpdateDialogAsAdmin();
    const optionValues = within(statusSelect)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(optionValues).not.toContain('closed');
    expect(optionValues).not.toContain('reopened');
  });

  it('still offers every currently-reachable active status as a target', async () => {
    const { statusSelect } = await openUpdateDialogAsAdmin();
    const optionValues = within(statusSelect)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    for (const s of [
      'new',
      'acknowledged',
      'in_progress',
      'waiting_external',
      'waiting_test',
      'monitoring',
      'partial_readiness',
      'resolved_pending_close',
    ]) {
      expect(optionValues).toContain(s);
    }
  });
});
