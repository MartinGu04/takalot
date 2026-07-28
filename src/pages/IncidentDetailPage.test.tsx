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
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type AppType from '../App';
import { isoToLocalInput } from '../lib/time';

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

// Chapter 2 incident-update vertical slice: actual event time (מועד העדכון
// בפועל), its bounds (migration 0020), and the full submit/refresh/timeline
// path -- exercised through the real app + real demo repository, mirroring
// the cancellation tests' approach below.
describe('UpdateDialog: actual event time (מועד העדכון בפועל)', () => {
  it('shows the renamed label, its helper text, and the two approved placeholders', async () => {
    await openUpdateDialogAsAdmin();
    const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });
    expect(within(dialog).getByLabelText(/^מועד העדכון בפועל/)).toBeInTheDocument();
    expect(
      within(dialog).getByText('המועד שבו העדכון או הפעולה התרחשו בפועל, גם אם התיעוד נעשה מאוחר יותר.'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByPlaceholderText('אילו בדיקות, פעולות או ניסיונות פתרון בוצעו מאז העדכון הקודם?'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByPlaceholderText('כיצד המצב הנוכחי משפיע על הפעילות, השירות או המשתמשים?'),
    ).toBeInTheDocument();
  });

  it('defaults the actual event-time field to now', async () => {
    const before = Date.now();
    await openUpdateDialogAsAdmin();
    const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });
    const input = within(dialog).getByLabelText(/^מועד העדכון בפועל/) as HTMLInputElement;
    expect(input.value).not.toBe('');
    const [datePart, timePart] = input.value.split('T');
    const [y, m, d] = datePart.split('-').map(Number);
    const [hh, mm] = timePart.split(':').map(Number);
    const asUtcGuess = Date.UTC(y, m - 1, d, hh, mm);
    expect(Math.abs(asUtcGuess - before)).toBeLessThan(4 * 3600_000);
  });

  it('blocks submission (client-side) when the event time is set before the incident was discovered, without closing the dialog', async () => {
    const { user } = await openUpdateDialogAsAdmin();
    const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });
    const input = within(dialog).getByLabelText(/^מועד העדכון בפועל/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2000-01-01T00:00' } });
    await user.type(within(dialog).getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/), 'עדכון');
    await user.click(within(dialog).getByRole('button', { name: 'שמירת עדכון' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'עדכון תקלה' })).toBeInTheDocument();
  });

  it('blocks submission (client-side) when the event time is set in the future beyond the tolerance', async () => {
    const { user } = await openUpdateDialogAsAdmin();
    const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });
    const input = within(dialog).getByLabelText(/^מועד העדכון בפועל/) as HTMLInputElement;
    // isoToLocalInput (not native Date getters) matches the app's own
    // Asia/Jerusalem wall-clock conversion, which is independent of the
    // test runner's OS/Node local timezone.
    const iso = isoToLocalInput(new Date(Date.now() + 3 * 3600_000).toISOString());
    fireEvent.change(input, { target: { value: iso } });
    await user.type(within(dialog).getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/), 'עדכון');
    await user.click(within(dialog).getByRole('button', { name: 'שמירת עדכון' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'עדכון תקלה' })).toBeInTheDocument();
  });

  it('submits successfully end-to-end: dialog closes, success toast, incident refreshes, and the timeline records the update with its actual event time', async () => {
    const { user } = await openUpdateDialogAsAdmin();
    const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });
    await user.type(within(dialog).getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/), 'בוצעה בדיקה נוספת');
    await user.click(within(dialog).getByRole('button', { name: 'שמירת עדכון' }));

    expect(await screen.findByText('העדכון נשמר.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'עדכון תקלה' })).not.toBeInTheDocument());

    const timeline = (await within(main()).findByText('ציר זמן')).closest('section') as HTMLElement;
    expect(within(timeline).getAllByText('עדכון טיפול').length).toBeGreaterThan(0);
    expect(within(timeline).getByText(/בוצעה בדיקה נוספת/)).toBeInTheDocument();
  });

  it('prevents duplicate submission by disabling the button while the update is pending', async () => {
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    const original = LocalDemoRepository.prototype.updateIncident;
    let resolveCall: (() => void) | undefined;
    const spy = vi
      .spyOn(LocalDemoRepository.prototype, 'updateIncident')
      .mockImplementationOnce(async function (
        this: InstanceType<typeof LocalDemoRepository>,
        ...args: Parameters<typeof original>
      ) {
        await new Promise<void>((resolve) => {
          resolveCall = resolve;
        });
        return original.apply(this, args);
      });

    const { user } = await openUpdateDialogAsAdmin();
    const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });
    await user.type(within(dialog).getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/), 'בדיקה');
    await user.click(within(dialog).getByRole('button', { name: 'שמירת עדכון' }));

    const pendingButton = await within(dialog).findByRole('button', { name: 'שומר…' });
    expect(pendingButton).toBeDisabled();
    expect(spy).toHaveBeenCalledTimes(1);
    await user.click(pendingButton);
    expect(spy).toHaveBeenCalledTimes(1);

    resolveCall?.();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'עדכון תקלה' })).not.toBeInTheDocument());
  });

  it('on a version conflict, keeps the dialog open, preserves entered content, and shows a clean Hebrew message', async () => {
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    const { AppError } = await import('../data/repository');
    const spy = vi
      .spyOn(LocalDemoRepository.prototype, 'updateIncident')
      .mockRejectedValueOnce(
        new AppError('CONFLICT', 'התקלה עודכנה על ידי משתמש אחר. יש לרענן את הדף לפני שמירה.'),
      );

    const { user } = await openUpdateDialogAsAdmin();
    const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });
    await user.type(within(dialog).getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/), 'תוכן שהוזן ולא אבד');
    await user.click(within(dialog).getByRole('button', { name: 'שמירת עדכון' }));

    expect(await screen.findByText('התקלה עודכנה על ידי משתמש אחר. יש לרענן את הדף לפני שמירה.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'עדכון תקלה' })).toBeInTheDocument();
    expect(
      (within(dialog).getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/) as HTMLTextAreaElement).value,
    ).toBe('תוכן שהוזן ולא אבד');
    spy.mockRestore();
  });
});

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
