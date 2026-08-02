// UpdateDialog's "מצב הטיפול" treatment-state control: exercised through the
// real app with the demo repository (real seeded incidents, real rules) --
// not a UI mock. The simplified model offers exactly three categories
// (בטיפול / בהמתנה / במעקב), with בהמתנה expanding into three structured,
// backend-reachable reasons (0028 widened is_valid_transition for two of
// them). closed/reopened/cancelled stay reachable only through their own
// dedicated flows; every legacy status (new/acknowledged/waiting_test/
// partial_readiness/resolved_pending_close) and waiting_equipment (not one
// of the three named reasons) are excluded from this control entirely.
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
  const statusSelect = await screen.findByRole('combobox', { name: /מצב הטיפול/ });
  return { user, statusSelect };
}

// The new required "סטטוס נוכחי" free-text field, filled by default in
// every test below unless a test is specifically exercising its absence --
// updateIncidentSchema rejects a blank value, so omitting this would make
// every "successful submission" test below fail client-side validation for
// an unrelated reason.
async function fillCurrentStatusText(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, text = 'המצב הנוכחי לצורך בדיקה') {
  await user.type(within(dialog).getByLabelText(/^סטטוס נוכחי/), text);
}

// The three new update-specific reporting questions (migration 0031), each
// required and each starting unanswered ('') whenever the dialog opens --
// filled with the simplest valid answer (no dependent recipient/number
// field) in every test below unless a test specifically exercises the
// unanswered state or a "yes" branch.
async function fillUpdateReporting(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.selectOptions(within(dialog).getByLabelText(/^דווח למבצעים\?/), 'not_required');
  await user.selectOptions(within(dialog).getByLabelText(/^האם דווח לתקשוב למבצעים\?/), 'no');
  await user.selectOptions(within(dialog).getByLabelText(/^האם עודכן ב-WISDOM\?/), 'no');
}

// Chapter 2 incident-update vertical slice: actual event time (מועד העדכון
// בפועל), its bounds (migration 0020), and the full submit/refresh/timeline
// path -- exercised through the real app + real demo repository, mirroring
// the cancellation tests' approach below.
describe('UpdateDialog: actual event time (מועד העדכון בפועל)', () => {
  it('shows the renamed label, its helper text, and the approved placeholders', async () => {
    await openUpdateDialogAsAdmin();
    const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });
    expect(within(dialog).getByLabelText(/^מועד העדכון בפועל/)).toBeInTheDocument();
    expect(
      within(dialog).getByText('המועד שבו העדכון או הפעולה התרחשו בפועל, גם אם התיעוד נעשה מאוחר יותר.'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByPlaceholderText('אילו בדיקות, פעולות או ניסיונות פתרון בוצעו מאז העדכון הקודם?'),
    ).toBeInTheDocument();
    // operational-impact editing was removed from the update flow entirely
    // (it stays a creation-time opening fact) -- its placeholder no longer
    // appears here. The new required "סטטוס נוכחי" field replaces its
    // situational purpose in this form.
    expect(
      within(dialog).getByPlaceholderText('לדוגמה: הצוות הטכני בדרך לאתר, ממתינים להערכת נזק.'),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByPlaceholderText('כיצד המצב הנוכחי משפיע על הפעילות, השירות או המשתמשים?'),
    ).not.toBeInTheDocument();
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

  it('requires the new "סטטוס נוכחי" field before a full update can be submitted', async () => {
    const { user } = await openUpdateDialogAsAdmin();
    const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });
    await user.type(within(dialog).getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/), 'עדכון ללא סטטוס נוכחי');
    await user.click(within(dialog).getByRole('button', { name: 'שמירת עדכון' }));

    expect(await within(dialog).findByText('סטטוס נוכחי: שדה חובה')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'עדכון תקלה' })).toBeInTheDocument();
  });

  it('submits successfully end-to-end: dialog closes, success toast, incident refreshes, and the timeline records the update with its actual event time', async () => {
    const { user } = await openUpdateDialogAsAdmin();
    const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });
    await user.type(within(dialog).getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/), 'בוצעה בדיקה נוספת');
    await fillCurrentStatusText(user, dialog);
    await fillUpdateReporting(user, dialog);
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
    await fillCurrentStatusText(user, dialog);
    await fillUpdateReporting(user, dialog);
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
    await fillCurrentStatusText(user, dialog);
    await fillUpdateReporting(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'שמירת עדכון' }));

    expect(await screen.findByText('התקלה עודכנה על ידי משתמש אחר. יש לרענן את הדף לפני שמירה.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'עדכון תקלה' })).toBeInTheDocument();
    expect(
      (within(dialog).getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/) as HTMLTextAreaElement).value,
    ).toBe('תוכן שהוזן ולא אבד');
    spy.mockRestore();
  });
});

describe('UpdateDialog resets only after a confirmed successful submission', () => {
  it('reopening after a successful update clears the event-specific text and re-seeds the structured state from the now-current incident', async () => {
    const { user, statusSelect } = await openUpdateDialogAsAdmin();
    const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });

    // inc-1 starts in_progress. Move it to monitoring and fill every
    // event-specific free-text field plus every update-specific reporting
    // question (all three answered "yes", with recipients, to prove they
    // are genuinely cleared on reopen rather than merely never having been
    // touched).
    expect(statusSelect).toHaveValue('in_progress');
    await user.selectOptions(statusSelect, 'monitoring');
    await user.type(within(dialog).getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/), 'פעולות של העדכון הזה');
    await user.type(within(dialog).getByLabelText(/^ממצאים/), 'ממצאים של העדכון הזה');
    await user.type(within(dialog).getByLabelText(/^פעולות המשך/), 'המשך של העדכון הזה');
    await fillCurrentStatusText(user, dialog, 'סטטוס נוכחי של העדכון הזה');
    await user.selectOptions(within(dialog).getByLabelText(/^דווח למבצעים\?/), 'yes');
    await user.type(within(dialog).getByLabelText(/^למי דווח\? \(מבצעים\)/), 'יוסי מהמוקד');
    await user.selectOptions(within(dialog).getByLabelText(/^האם דווח לתקשוב למבצעים\?/), 'yes');
    await user.type(within(dialog).getByLabelText(/^למי דווח\? \(תקשוב למבצעים\)/), 'דנה מהתקשוב');
    await user.selectOptions(within(dialog).getByLabelText(/^האם עודכן ב-WISDOM\?/), 'yes');
    await user.click(within(dialog).getByRole('button', { name: 'שמירת עדכון' }));

    expect(await screen.findByText('העדכון נשמר.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'עדכון תקלה' })).not.toBeInTheDocument());

    await user.click(await within(main()).findByRole('button', { name: 'עדכון תקלה' }));
    const reopened = await screen.findByRole('dialog', { name: 'עדכון תקלה' });

    // Event-specific content belongs to the previous update only.
    expect(within(reopened).getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/)).toHaveValue('');
    expect(within(reopened).getByLabelText(/^ממצאים/)).toHaveValue('');
    expect(within(reopened).getByLabelText(/^פעולות המשך/)).toHaveValue('');
    expect(within(reopened).getByLabelText(/^סטטוס נוכחי/)).toHaveValue('');
    expect(within(reopened).queryByRole('alert')).not.toBeInTheDocument();

    // Every update-specific reporting question is back to unanswered ('') --
    // never re-seeded to "yes"/"no" from the previous submission, and never
    // preloaded from the incident's own opening-time reporting facts.
    expect(within(reopened).getByLabelText(/^דווח למבצעים\?/)).toHaveValue('');
    expect(within(reopened).getByLabelText(/^האם דווח לתקשוב למבצעים\?/)).toHaveValue('');
    expect(within(reopened).getByLabelText(/^האם עודכן ב-WISDOM\?/)).toHaveValue('');
    expect(within(reopened).queryByLabelText(/^למי דווח\? \(מבצעים\)/)).not.toBeInTheDocument();
    expect(within(reopened).queryByLabelText(/^למי דווח\? \(תקשוב למבצעים\)/)).not.toBeInTheDocument();

    // Structured state is the incident's CURRENT state, freshly seeded --
    // monitoring, not the in_progress this page first rendered with.
    expect(within(reopened).getByRole('combobox', { name: /מצב הטיפול/ })).toHaveValue('monitoring');

    // The event time is re-defaulted to "now" rather than kept from the
    // previous submission.
    const eventTime = within(reopened).getByLabelText(/^מועד העדכון בפועל/) as HTMLInputElement;
    expect(eventTime.value.slice(0, 16)).toBe(isoToLocalInput(new Date().toISOString()).slice(0, 16));
  });

  it('after a failed update the dialog stays open and every entered value survives, including the structured ones', async () => {
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    const { AppError } = await import('../data/repository');
    const spy = vi
      .spyOn(LocalDemoRepository.prototype, 'updateIncident')
      .mockRejectedValue(new AppError('NETWORK', 'אירעה שגיאה. הנתונים שהוזנו לא נשמרו — ניתן לנסות שוב.'));
    try {
      const { user, statusSelect } = await openUpdateDialogAsAdmin();
      const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });
      await user.selectOptions(statusSelect, 'monitoring');
      await user.type(within(dialog).getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/), 'תוכן שלא נשמר');
      await user.type(within(dialog).getByLabelText(/^ממצאים/), 'ממצאים שלא נשמרו');
      await fillCurrentStatusText(user, dialog, 'סטטוס נוכחי שלא נשמר');
      await user.selectOptions(within(dialog).getByLabelText(/^דווח למבצעים\?/), 'yes');
      await user.type(within(dialog).getByLabelText(/^למי דווח\? \(מבצעים\)/), 'יוסי מהמוקד');
      await user.selectOptions(within(dialog).getByLabelText(/^האם דווח לתקשוב למבצעים\?/), 'no');
      await user.selectOptions(within(dialog).getByLabelText(/^האם עודכן ב-WISDOM\?/), 'no');
      await user.click(within(dialog).getByRole('button', { name: 'שמירת עדכון' }));

      expect(await screen.findByText('אירעה שגיאה. הנתונים שהוזנו לא נשמרו — ניתן לנסות שוב.')).toBeInTheDocument();
      const stillOpen = screen.getByRole('dialog', { name: 'עדכון תקלה' });
      expect(within(stillOpen).getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/)).toHaveValue('תוכן שלא נשמר');
      expect(within(stillOpen).getByLabelText(/^ממצאים/)).toHaveValue('ממצאים שלא נשמרו');
      expect(within(stillOpen).getByLabelText(/^סטטוס נוכחי/)).toHaveValue('סטטוס נוכחי שלא נשמר');
      expect(within(stillOpen).getByRole('combobox', { name: /מצב הטיפול/ })).toHaveValue('monitoring');
      // Update-specific reporting answers survive the failure too.
      expect(within(stillOpen).getByLabelText(/^דווח למבצעים\?/)).toHaveValue('yes');
      expect(within(stillOpen).getByLabelText(/^למי דווח\? \(מבצעים\)/)).toHaveValue('יוסי מהמוקד');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('UpdateDialog מצב הטיפול control: simplified three-state treatment model', () => {
  it('offers exactly בטיפול / בהמתנה / במעקב for an incident already in one of those three states (inc-1 is in_progress)', async () => {
    const { statusSelect } = await openUpdateDialogAsAdmin();
    const optionValues = within(statusSelect)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(optionValues).toEqual(['in_progress', 'waiting', 'monitoring']);
    // Nothing terminal, legacy, or not-yet-reachable is ever an option here --
    // closed/reopened/cancelled (dedicated flows) and every legacy status
    // (new/acknowledged/waiting_test/partial_readiness/resolved_pending_close)
    // simply never appear in this simplified control.
    for (const s of ['closed', 'reopened', 'cancelled', 'new', 'acknowledged', 'waiting_test', 'partial_readiness', 'resolved_pending_close', 'waiting_equipment']) {
      expect(optionValues).not.toContain(s);
    }
  });

  it('selecting בהמתנה reveals a required סיבת ההמתנה select with the three structured, backend-reachable reasons', async () => {
    const { user, statusSelect } = await openUpdateDialogAsAdmin();
    expect(screen.queryByRole('combobox', { name: /^סיבת ההמתנה/ })).not.toBeInTheDocument();
    await user.selectOptions(statusSelect, 'waiting');
    const reasonSelect = await screen.findByRole('combobox', { name: /^סיבת ההמתנה/ });
    const reasonValues = within(reasonSelect)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    // waiting_equipment is deliberately excluded -- not one of the three
    // named reasons this model offers, even though 0028 leaves it a valid
    // stored/displayable status.
    expect(reasonValues).toEqual(['waiting_external', 'waiting_information', 'waiting_validation']);
  });

  it('choosing a waiting reason sets the underlying status to that exact enum value (now backend-reachable per 0028)', async () => {
    const { user, statusSelect } = await openUpdateDialogAsAdmin();
    await user.selectOptions(statusSelect, 'waiting');
    const reasonSelect = await screen.findByRole('combobox', { name: /^סיבת ההמתנה/ });
    await user.selectOptions(reasonSelect, 'waiting_information');
    expect(reasonSelect).toHaveValue('waiting_information');

    await user.selectOptions(reasonSelect, 'waiting_validation');
    expect(reasonSelect).toHaveValue('waiting_validation');
  });

  it('switching back to בטיפול or במעקב hides the סיבת ההמתנה select again', async () => {
    const { user, statusSelect } = await openUpdateDialogAsAdmin();
    await user.selectOptions(statusSelect, 'waiting');
    await screen.findByRole('combobox', { name: /^סיבת ההמתנה/ });
    await user.selectOptions(statusSelect, 'monitoring');
    expect(screen.queryByRole('combobox', { name: /^סיבת ההמתנה/ })).not.toBeInTheDocument();
  });
});

// Update-specific reporting (migration 0031): three fresh per-update
// questions, never preloaded from the incident's own opening-time
// reportedToOps/reportedToComms/wisdomReported facts, never persisted onto
// them, and rendered on the specific update entry in the timeline.
describe('UpdateDialog update-specific reporting (migration 0031)', () => {
  it("never preloads any of the three questions from the incident's own opening-time reporting facts, even when those facts are answered", async () => {
    // inc-1 (seed.ts) opens with reportedToOps: 'yes' (a non-default,
    // clearly-truthy answer) -- if the dialog were (bugged) seeding from it,
    // this select would show 'yes' on open instead of the unanswered ''.
    await openUpdateDialogAsAdmin();
    const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });
    expect(within(dialog).getByLabelText(/^דווח למבצעים\?/)).toHaveValue('');
    expect(within(dialog).getByLabelText(/^האם דווח לתקשוב למבצעים\?/)).toHaveValue('');
    expect(within(dialog).getByLabelText(/^האם עודכן ב-WISDOM\?/)).toHaveValue('');
    expect(within(dialog).queryByLabelText(/^למי דווח\?/)).not.toBeInTheDocument();
  });

  it('blocks submission until all three questions are explicitly answered', async () => {
    const { user } = await openUpdateDialogAsAdmin();
    const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });
    await user.type(within(dialog).getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/), 'עדכון');
    await fillCurrentStatusText(user, dialog);
    // Leave the reporting questions unanswered.
    await user.click(within(dialog).getByRole('button', { name: 'שמירת עדכון' }));

    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'עדכון תקלה' })).toBeInTheDocument();
  });

  it('requires a recipient only when a yes/no reporting question is answered "yes"', async () => {
    const { user } = await openUpdateDialogAsAdmin();
    const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });
    expect(screen.queryByLabelText(/^למי דווח\? \(מבצעים\)/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^למי דווח\? \(תקשוב למבצעים\)/)).not.toBeInTheDocument();

    await user.selectOptions(within(dialog).getByLabelText(/^דווח למבצעים\?/), 'yes');
    expect(within(dialog).getByLabelText(/^למי דווח\? \(מבצעים\)/)).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText(/^דווח למבצעים\?/), 'no');
    expect(screen.queryByLabelText(/^למי דווח\? \(מבצעים\)/)).not.toBeInTheDocument();

    await user.selectOptions(within(dialog).getByLabelText(/^האם דווח לתקשוב למבצעים\?/), 'yes');
    expect(within(dialog).getByLabelText(/^למי דווח\? \(תקשוב למבצעים\)/)).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText(/^האם דווח לתקשוב למבצעים\?/), 'no');
    expect(screen.queryByLabelText(/^למי דווח\? \(תקשוב למבצעים\)/)).not.toBeInTheDocument();

    // WISDOM never has a dependent recipient/number field, in either state.
    await user.selectOptions(within(dialog).getByLabelText(/^האם עודכן ב-WISDOM\?/), 'yes');
    expect(screen.queryByText(/מספר תקלה ב-WISDOM/)).not.toBeInTheDocument();
  });

  it('persists and renders all three reporting answers on the specific update entry in the timeline', async () => {
    const { user } = await openUpdateDialogAsAdmin();
    const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });
    await user.type(within(dialog).getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/), 'דיווח מלא בעדכון זה');
    await fillCurrentStatusText(user, dialog);
    await user.selectOptions(within(dialog).getByLabelText(/^דווח למבצעים\?/), 'yes');
    await user.type(within(dialog).getByLabelText(/^למי דווח\? \(מבצעים\)/), 'יוסי מהמוקד');
    await user.selectOptions(within(dialog).getByLabelText(/^האם דווח לתקשוב למבצעים\?/), 'yes');
    await user.type(within(dialog).getByLabelText(/^למי דווח\? \(תקשוב למבצעים\)/), 'דנה מהתקשוב');
    await user.selectOptions(within(dialog).getByLabelText(/^האם עודכן ב-WISDOM\?/), 'yes');
    await user.click(within(dialog).getByRole('button', { name: 'שמירת עדכון' }));

    expect(await screen.findByText('העדכון נשמר.')).toBeInTheDocument();
    // inc-1 already has an older seeded update carrying its own "yes"
    // reporting answers (seed.ts, upd-1a) -- scope to THIS update's own
    // entry (identified by its distinctive actionsTaken text) so the
    // assertions can't accidentally pass against the older row.
    const entry = (await within(main()).findByText(/דיווח מלא בעדכון זה/)).closest('li') as HTMLElement;
    expect(within(entry).getByText(/דווח למבצעים בעדכון זה:/)).toBeInTheDocument();
    expect(within(entry).getByText(/יוסי מהמוקד/)).toBeInTheDocument();
    expect(within(entry).getByText(/דווח לתקשוב למבצעים בעדכון זה:/)).toBeInTheDocument();
    expect(within(entry).getByText(/דנה מהתקשוב/)).toBeInTheDocument();
    expect(within(entry).getByText(/עודכן ב-WISDOM בעדכון זה:/)).toBeInTheDocument();
  });

  it('a historical update row with no recorded reporting answers renders with no reporting lines at all', async () => {
    // inc-7's seeded upd-7a (seed.ts) has every update-specific reporting
    // field set to null -- the legacy/historical render path. inc-7 isn't
    // among the dashboard's own sections, so reach it via the full
    // incidents list instead (mirroring ArchivePage.test.tsx's navigation
    // pattern).
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    const sidebarNav = screen.getByRole('navigation', { name: 'ניווט ראשי' });
    await user.click(within(sidebarNav).getByRole('link', { name: 'תקלות' }));
    const card = await within(main()).findByText(/נדרש רענון ידני של התצוגה/);
    await user.click(card.closest('a.incident-card') as HTMLElement);
    const timeline = (await within(main()).findByText('ציר זמן')).closest('section') as HTMLElement;
    expect(within(timeline).queryByText(/דווח למבצעים בעדכון זה:/)).not.toBeInTheDocument();
    expect(within(timeline).queryByText(/דווח לתקשוב למבצעים בעדכון זה:/)).not.toBeInTheDocument();
    expect(within(timeline).queryByText(/עודכן ב-WISDOM בעדכון זה:/)).not.toBeInTheDocument();
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

async function openMoreActions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await within(main()).findByRole('button', { name: 'פעולות נוספות' }));
  return screen.findByRole('menu', { name: 'פעולות נוספות לתקלה' });
}

async function openCancelDialogAsAdmin() {
  const user = await openIncidentDetailAsAdmin();
  const menu = await openMoreActions(user);
  await user.click(within(menu).getByRole('menuitem', { name: 'ביטול תקלה' }));
  const dialog = await screen.findByRole('dialog', { name: 'ביטול תקלה' });
  return { user, dialog };
}

describe('incident actions: hierarchy and overflow', () => {
  it('keeps update primary, close/assignment secondary, and separates export from destructive cancellation', async () => {
    const user = await openIncidentDetailAsAdmin();
    const actions = await within(main()).findByRole('region', { name: 'פעולות תקלה' });
    const update = within(actions).getByRole('button', { name: 'עדכון תקלה' });
    const close = within(actions).getByRole('button', { name: 'סגירת תקלה' });
    const assign = within(actions).getByRole('button', { name: 'שינוי גורם מטפל' });

    // Update stays the one filled/primary action. Closure and reassignment
    // are still secondary -- tinted surfaces, never a filled brand fill --
    // but now carry their own distinct tone instead of both reading as the
    // same neutral surface button.
    expect(update).toHaveClass('bg-brand-600');
    expect(close).toHaveClass('bg-green-50');
    expect(close).not.toHaveClass('bg-brand-600');
    expect(assign).toHaveClass('bg-indigo-50');
    expect(assign).not.toHaveClass('bg-brand-600');
    expect(close.className).not.toEqual(assign.className);
    expect(within(actions).queryByRole('button', { name: 'ייצוא PDF' })).not.toBeInTheDocument();
    expect(within(actions).queryByRole('button', { name: 'ביטול תקלה' })).not.toBeInTheDocument();

    const menu = await openMoreActions(user);
    expect(within(menu).getByRole('menuitem', { name: 'ייצוא PDF' })).toBeInTheDocument();
    const cancel = within(menu).getByRole('menuitem', { name: 'ביטול תקלה' });
    expect(cancel).toHaveClass('text-red-700');
    expect(cancel.parentElement).toHaveClass('border-t');
  });

  it('opens from the keyboard, supports arrow navigation, and returns focus on Escape', async () => {
    const user = await openIncidentDetailAsAdmin();
    const trigger = await within(main()).findByRole('button', { name: 'פעולות נוספות' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    const menu = await screen.findByRole('menu', { name: 'פעולות נוספות לתקלה' });
    const pdf = within(menu).getByRole('menuitem', { name: 'ייצוא PDF' });
    const cancel = within(menu).getByRole('menuitem', { name: 'ביטול תקלה' });
    await waitFor(() => expect(pdf).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(cancel).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
  });
});

describe('incident cancellation: visibility', () => {
  it('offers the action to an operational role on an open incident', async () => {
    const user = await openIncidentDetailAsAdmin();
    const menu = await openMoreActions(user);
    expect(within(menu).getByRole('menuitem', { name: 'ביטול תקלה' })).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'פעולות נוספות' })).not.toBeInTheDocument();
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
    const menu = await openMoreActions(user);
    expect(within(menu).queryByRole('menuitem', { name: 'ביטול תקלה' })).not.toBeInTheDocument();
  });
});

// Migration 0037: an active technician gains close_incident and
// assign_incident -- independent of the incident's current owner -- while
// cancel_incident, reopen_incident and full_update stay exactly as before.
// inc-4 (seed.ts): status "monitoring" (non-terminal), owned by
// supervisor1 -- not the technician actor below.
describe('technician incident actions (migration 0037)', () => {
  it('offers close and reassignment on a non-terminal incident owned by someone else, but never cancel/reopen/full-update controls', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-tech-1'));
    const card = await within(main()).findByText(/אין פגיעה תפקודית\. במעקב טמפרטורה כל שעתיים/);
    await user.click(card.closest('a.incident-card') as HTMLElement);
    await within(main()).findByText('בעל אחריות פנימי'); // confirms the detail page loaded

    expect(within(main()).getByRole('button', { name: 'סגירת תקלה' })).toBeInTheDocument();
    expect(within(main()).getByRole('button', { name: 'שינוי גורם מטפל' })).toBeInTheDocument();

    // No cancel/export overflow menu (technician still lacks cancel_incident
    // and export_data) and no reopen button (only ever shown once closed).
    expect(screen.queryByRole('button', { name: 'פעולות נוספות' })).not.toBeInTheDocument();
    expect(within(main()).queryByRole('button', { name: 'פתיחה מחדש' })).not.toBeInTheDocument();

    // technician_update_incident's owner scoping is unaffected by 0037: the
    // "עדכון תקלה" action stays unavailable on an incident this technician
    // does not own (canFullUpdate is false, canTechnicianUpdate requires
    // ownership) even though close/assign are now offered on it.
    expect(within(main()).queryByRole('button', { name: 'עדכון תקלה' })).not.toBeInTheDocument();
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
    expect(within(main()).queryByRole('button', { name: 'סגירת תקלה' })).not.toBeInTheDocument();
    expect(within(main()).queryByRole('button', { name: 'עדכון תקלה' })).not.toBeInTheDocument();
    const menu = await openMoreActions(user);
    expect(within(menu).queryByRole('menuitem', { name: 'ביטול תקלה' })).not.toBeInTheDocument();

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

// Migration 0021 (incident-opening completion): תקשוב למבצעים / WISDOM must
// render correctly both for a freshly created incident (already covered end
// to end in IncidentCreatePage.test.tsx) and for PRE-EXISTING seeded
// incidents that were never created through that new form -- proving the
// detail page reads these fields correctly for "old" data too, not just
// data shaped by the newest create-flow code path.
const INC2_TEXT = /עיכוב בקבלת נתונים בעמדת הבקרה/; // inc-2: reportedToComms = true (seed.ts)
const INC4_TEXT = /אין פגיעה תפקודית\. במעקב טמפרטורה כל שעתיים/; // inc-4: wisdomReported = true (seed.ts)

// Demo login always redirects to '/' (LoginPage.tsx); like the helpers
// above, incidents must be reached via a real link click from the
// dashboard, not by pre-seeding the URL.
async function openIncidentDetailByTextAsAdmin(text: RegExp) {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByTestId('login-u-admin'));
  const card = await within(main()).findByText(text);
  await user.click(card.closest('a.incident-card') as HTMLElement);
  await within(main()).findByText('בעל אחריות פנימי'); // confirms the detail page loaded
  return { user };
}

describe('incident details: תקשוב למבצעים / WISDOM (migration 0021 parity)', () => {
  it('a seeded incident with תקשוב למבצעים כן shows the reported recipient', async () => {
    await openIncidentDetailByTextAsAdmin(INC2_TEXT);

    const commsRow = within(main()).getByText('תקשוב למבצעים').closest('div') as HTMLElement;
    expect(within(commsRow).getByText('כן')).toBeInTheDocument();
    expect(within(commsRow).getByText(/תקשוב מוקד מבצעים \(דמו\)/)).toBeInTheDocument();
  });

  it('a seeded incident with WISDOM כן shows its incident number', async () => {
    await openIncidentDetailByTextAsAdmin(INC4_TEXT);
    const wisdomRow = within(main()).getByText('WISDOM').closest('div') as HTMLElement;
    expect(within(wisdomRow).getByText('כן')).toBeInTheDocument();
    expect(within(wisdomRow).getByText(/WISDOM-2026-0412/)).toBeInTheDocument();
  });

  it('an incident with no answers set shows לא for both fields with no dependent value', async () => {
    await openIncidentDetailByTextAsAdmin(INC1_TEXT);
    const commsRow1 = within(main()).getByText('תקשוב למבצעים').closest('div') as HTMLElement;
    expect(within(commsRow1).getByText('לא')).toBeInTheDocument();
    const wisdomRow1 = within(main()).getByText('WISDOM').closest('div') as HTMLElement;
    expect(within(wisdomRow1).getByText('לא')).toBeInTheDocument();
  });
});

// inc-3: legacy external-only fixture (owner_user_id null, owner_external_name
// set, seed.ts). Migration 0032's additive external handling party model
// requires the internal owner and the external handler to always render as
// two separate facts, never collapsed into one -- even for a legacy row
// predating the model.
const INC3_TEXT = /מערכת גמא עובדת במצב גיבוי/;

describe('incident details: internal owner and external handler render as two separate facts (migration 0032)', () => {
  it('a legacy external-only incident shows "ללא בעל אחריות פנימי" for the internal owner, and the legacy name under a separate "גורם מטפל חיצוני" fact', async () => {
    await openIncidentDetailByTextAsAdmin(INC3_TEXT);
    const ownerRow = within(main()).getByText('בעל אחריות פנימי').closest('div') as HTMLElement;
    expect(within(ownerRow).getByText('ללא בעל אחריות פנימי')).toBeInTheDocument();
    const externalRow = within(main()).getByText('גורם מטפל חיצוני').closest('div') as HTMLElement;
    expect(within(externalRow).getByText(/טכנאי מטעם ספק \(חברת דוגמה בע״מ\)/)).toBeInTheDocument();
  });

  it('an incident with a real internal owner and no external handler shows no "גורם מטפל חיצוני" fact at all', async () => {
    await openIncidentDetailByTextAsAdmin(INC1_TEXT); // inc-1: internal owner, no external handler
    expect(within(main()).queryByText('גורם מטפל חיצוני')).not.toBeInTheDocument();
  });
});

// Temporary operational workaround (no real WhatsApp integration yet):
// NotificationCopyDialog, shown after a confirmed successful CLOSURE.
// inc-1 is owned by tech1 ("עומר פרץ (דמו)"); every test here signs in as
// u-admin ("אלון ברק (דמו)") to prove the actor comes from the authenticated
// profile, not the incident's own (editable) owner field.
async function fillCloseDialogMinimalFields(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.type(within(dialog).getByLabelText(/^סיבת התקלה/), 'תקלת חומרה');
  await user.type(within(dialog).getByLabelText(/^הפתרון שבוצע/), 'הוחלף רכיב');
}

describe('IncidentDetailPage: WhatsApp notification-copy modal (post-closure)', () => {
  it('does not appear before closing, appears only after a confirmed successful full closure, and its message uses the persisted data, the authenticated actor (never the incident owner), and the exact duration CloseDialog itself previewed', async () => {
    const user = await openIncidentDetailAsAdmin();
    expect(screen.queryByRole('dialog', { name: 'התקלה נסגרה בהצלחה' })).not.toBeInTheDocument();
    const heading = await within(main()).findByRole('heading', { level: 1 });
    const incidentNumber = heading.textContent?.match(/\d{4}-\d{3}/)?.[0];
    expect(incidentNumber).toBeTruthy();

    await user.click(await within(main()).findByRole('button', { name: 'סגירת תקלה' }));
    const closeDialog = await screen.findByRole('dialog', { name: 'סגירת תקלה' });
    await fillCloseDialogMinimalFields(user, closeDialog);

    // CloseDialog's own pre-confirm duration preview (regression-tested
    // elsewhere to reflect the selected effective closure time, never the
    // current clock) is the source of truth this test cross-checks against.
    const previewText = within(closeDialog).getByText(/^משך התקלה למועד הסגירה שנבחר:/).textContent ?? '';
    const expectedDuration = previewText.replace('משך התקלה למועד הסגירה שנבחר: ', '');
    expect(expectedDuration).not.toBe('');

    await user.click(within(closeDialog).getByRole('button', { name: 'המשך לאישור סגירה' }));
    expect(screen.queryByRole('dialog', { name: 'התקלה נסגרה בהצלחה' })).not.toBeInTheDocument(); // not yet confirmed
    await user.click(await within(closeDialog).findByRole('button', { name: 'אישור סגירת תקלה' }));

    const notification = await screen.findByRole('dialog', { name: 'התקלה נסגרה בהצלחה' });
    expect(
      within(notification).getByText(/כרגע AVARIA עדיין לא שולחת התראות אוטומטיות לוואטסאפ/),
    ).toBeInTheDocument();
    const message = within(notification).getByRole('group', { name: 'תוכן ההודעה להעתקה' }).textContent ?? '';
    expect(message).toBe(`✅ תקלה ${incidentNumber} במערכת מערכת אלפא נסגרה על ידי אלון ברק (דמו) לאחר ${expectedDuration}`);
    expect(message).not.toContain('עומר פרץ'); // inc-1's owner (tech1) -- never the actor
  });

  it('does not appear when the close request fails', async () => {
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    const { AppError } = await import('../data/repository');
    const spy = vi
      .spyOn(LocalDemoRepository.prototype, 'closeIncident')
      .mockRejectedValueOnce(
        new AppError('CONFLICT', 'התקלה עודכנה על ידי משתמש אחר. יש לרענן את הדף לפני שמירה.'),
      );

    const user = await openIncidentDetailAsAdmin();
    await user.click(await within(main()).findByRole('button', { name: 'סגירת תקלה' }));
    const closeDialog = await screen.findByRole('dialog', { name: 'סגירת תקלה' });
    await fillCloseDialogMinimalFields(user, closeDialog);
    await user.click(within(closeDialog).getByRole('button', { name: 'המשך לאישור סגירה' }));
    await user.click(await within(closeDialog).findByRole('button', { name: 'אישור סגירת תקלה' }));

    expect(await screen.findByText('התקלה עודכנה על ידי משתמש אחר. יש לרענן את הדף לפני שמירה.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'התקלה נסגרה בהצלחה' })).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it('does not appear for a partial-readiness submission -- the incident stays open, so it never actually "closes"', async () => {
    const user = await openIncidentDetailAsAdmin();
    await user.click(await within(main()).findByRole('button', { name: 'סגירת תקלה' }));
    const closeDialog = await screen.findByRole('dialog', { name: 'סגירת תקלה' });
    await fillCloseDialogMinimalFields(user, closeDialog);
    await user.selectOptions(within(closeDialog).getByLabelText(/^כשירות המערכת/), 'partial');
    await user.type(within(closeDialog).getByLabelText(/^פעולות המשך/), 'להשלים בדיקה נוספת');
    await user.click(within(closeDialog).getByRole('button', { name: 'המשך לאישור סגירה' }));
    await user.click(await within(closeDialog).findByRole('button', { name: 'אישור ושמירה' }));

    expect(await screen.findByText('התקלה נסגרה.')).toBeInTheDocument(); // the mutation itself still succeeds
    expect(screen.queryByRole('dialog', { name: 'התקלה נסגרה בהצלחה' })).not.toBeInTheDocument();
  });

  it('a normal incident update never triggers either notification modal', async () => {
    const { user } = await openUpdateDialogAsAdmin();
    const dialog = screen.getByRole('dialog', { name: 'עדכון תקלה' });
    await user.type(within(dialog).getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/), 'עדכון רגיל');
    await fillCurrentStatusText(user, dialog);
    await fillUpdateReporting(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'שמירת עדכון' }));

    expect(await screen.findByText('העדכון נשמר.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'התקלה נפתחה בהצלחה' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'התקלה נסגרה בהצלחה' })).not.toBeInTheDocument();
  });
});
