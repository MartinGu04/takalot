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
import { render, screen, within, waitFor } from '@testing-library/react';
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

// Incident-cancellation vertical slice: real app, real demo repository --
// exercises the UI -> repository -> local "RPC" -> refetch -> display ->
// timeline path end to end, mirroring the UpdateDialog tests' approach above.
async function openIncidentDetailAsAdmin() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByTestId('login-u-admin'));
  const card = await within(main()).findByText(INC1_TEXT);
  await user.click(card.closest('a.incident-card') as HTMLElement);
  return user;
}

async function openCancelDialogAsAdmin() {
  const user = await openIncidentDetailAsAdmin();
  await user.click(await within(main()).findByRole('button', { name: 'ביטול תקלה' }));
  const dialog = await screen.findByRole('dialog', { name: 'ביטול תקלה' });
  return { user, dialog };
}

describe('incident cancellation: visibility', () => {
  it('offers the action to an operational role on an open incident', async () => {
    await openIncidentDetailAsAdmin();
    expect(await within(main()).findByRole('button', { name: 'ביטול תקלה' })).toBeInTheDocument();
  });

  it('does not offer the action to a technician (no cancel_incident capability)', async () => {
    const user = userEvent.setup();
    render(<App />);
    // inc-1 is owned by tech1, so the technician can reach its detail page
    // via technical_update, but is never an operational role.
    await user.click(await screen.findByTestId('login-u-tech-1'));
    const card = await within(main()).findByText(INC1_TEXT);
    await user.click(card.closest('a.incident-card') as HTMLElement);
    await within(main()).findByText(INC1_TEXT); // confirms the detail page loaded
    expect(screen.queryByRole('button', { name: 'ביטול תקלה' })).not.toBeInTheDocument();
  });

  it('does not offer the action once the incident is already terminal (closed)', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    const heading = await within(main()).findByText('נסגרו לאחרונה');
    const section = heading.closest('section') as HTMLElement;
    const link = within(section)
      .getAllByRole('link')
      .find((a) => (a as HTMLAnchorElement).getAttribute('href')?.startsWith('/incidents/'));
    await user.click(link as HTMLElement);
    await within(main()).findByText('סיכום סגירה'); // confirms we landed on a closed incident's page
    expect(screen.queryByRole('button', { name: 'ביטול תקלה' })).not.toBeInTheDocument();
  });
});

describe('incident cancellation: dialog and submission', () => {
  it('shows the incident number, a required reason field, and a datetime field defaulted to now', async () => {
    const { dialog } = await openCancelDialogAsAdmin();
    expect(within(dialog).getByText(/^\d{4}-\d{3}$/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^סיבת הביטול/)).toBeInTheDocument();
    const dateInput = within(dialog).getByLabelText(/^מועד הביטול בפועל/) as HTMLInputElement;
    expect(dateInput.value).not.toBe('');
    expect(within(dialog).getByRole('button', { name: 'חזרה' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'בטל תקלה' })).toBeInTheDocument();
  });

  it('rejects submission without a cancellation reason', async () => {
    const { user, dialog } = await openCancelDialogAsAdmin();
    await user.click(within(dialog).getByRole('button', { name: 'בטל תקלה' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    // still open -- no premature status change
    expect(screen.getByRole('dialog', { name: 'ביטול תקלה' })).toBeInTheDocument();
  });

  it('cancels the incident end-to-end: dialog closes, status becomes בוטלה, normal actions disappear, timeline records the reason', async () => {
    const { user, dialog } = await openCancelDialogAsAdmin();
    await user.type(within(dialog).getByLabelText(/^סיבת הביטול/), 'התקלה נפתחה בטעות על ידי המפעיל');
    await user.click(within(dialog).getByRole('button', { name: 'בטל תקלה' }));

    expect(await screen.findByText('התקלה בוטלה.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ביטול תקלה' })).not.toBeInTheDocument());

    await waitFor(() => expect(within(main()).getAllByText('בוטלה').length).toBeGreaterThan(0));
    expect(within(main()).queryByRole('button', { name: 'ביטול תקלה' })).not.toBeInTheDocument();
    expect(within(main()).queryByRole('button', { name: 'סגירת תקלה' })).not.toBeInTheDocument();
    expect(within(main()).queryByRole('button', { name: 'עדכון תקלה' })).not.toBeInTheDocument();

    const timeline = (await within(main()).findByText('ציר זמן')).closest('section') as HTMLElement;
    expect(within(timeline).getByText('התקלה נפתחה בטעות על ידי המפעיל')).toBeInTheDocument();
  });

  it('preserves the entered reason and shows a clear Hebrew error without closing the dialog on failure', async () => {
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    const { AppError } = await import('../data/repository');
    const spy = vi
      .spyOn(LocalDemoRepository.prototype, 'cancelIncident')
      .mockRejectedValueOnce(
        new AppError('CONFLICT', 'התקלה עודכנה על ידי משתמש אחר. יש לרענן את הדף לפני שמירה.'),
      );

    const { user, dialog } = await openCancelDialogAsAdmin();
    await user.type(within(dialog).getByLabelText(/^סיבת הביטול/), 'נפתחה בטעות');
    await user.click(within(dialog).getByRole('button', { name: 'בטל תקלה' }));

    expect(await screen.findByText('התקלה עודכנה על ידי משתמש אחר. יש לרענן את הדף לפני שמירה.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'ביטול תקלה' })).toBeInTheDocument();
    expect((within(dialog).getByLabelText(/^סיבת הביטול/) as HTMLTextAreaElement).value).toBe('נפתחה בטעות');
    spy.mockRestore();
  });

  it('disables the confirm button while submitting, preventing a duplicate call', async () => {
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    const original = LocalDemoRepository.prototype.cancelIncident;
    let resolveCall: (() => void) | undefined;
    const spy = vi
      .spyOn(LocalDemoRepository.prototype, 'cancelIncident')
      .mockImplementationOnce(async function (
        this: InstanceType<typeof LocalDemoRepository>,
        ...args: Parameters<typeof original>
      ) {
        await new Promise<void>((resolve) => {
          resolveCall = resolve;
        });
        return original.apply(this, args);
      });

    const { user, dialog } = await openCancelDialogAsAdmin();
    await user.type(within(dialog).getByLabelText(/^סיבת הביטול/), 'נפתחה בטעות');
    await user.click(within(dialog).getByRole('button', { name: 'בטל תקלה' }));

    const pendingButton = await within(dialog).findByRole('button', { name: 'מבטל…' });
    expect(pendingButton).toBeDisabled();
    expect(spy).toHaveBeenCalledTimes(1);

    // A disabled button ignores further clicks -- no second call is made.
    await user.click(pendingButton);
    expect(spy).toHaveBeenCalledTimes(1);

    resolveCall?.();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ביטול תקלה' })).not.toBeInTheDocument());
  });
});
