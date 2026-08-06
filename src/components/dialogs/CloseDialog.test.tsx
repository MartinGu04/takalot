// Regression coverage for a retrospective-closure duration bug: the
// duration shown in CloseDialog (both the pre-confirm hint and the
// confirmation step) must be `selected effective closure time -
// incident.discoveredAt`, not `now - incident.discoveredAt`. Before the
// fix, the dialog used `new Date()` at render time, so a retrospectively
// backdated closure (e.g. closed one minute after discovery, but recorded
// weeks later) showed the elapsed wall-clock time since discovery instead
// of the actual one-minute operational duration.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Incident } from '../../domain/types';
import { CloseDialog } from './CloseDialog';

vi.mock('../../data/hooks', () => ({
  useProfiles: () => ({ data: [] }),
  useIncidentTreatmentActions: () => ({ data: [] }),
}));

function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'i1',
    number: '2026-001',
    version: 1,
    systemId: 'sys',
    locationId: 'loc',
    description: 'desc',
    severity: 'medium',
    status: 'in_progress',
    operationalImpact: 'impact',
    reportedDomain: null,
    currentSuspectedCause: null,
    currentSuspectedCauseOtherDetail: null,
    ownerUserId: 'u-admin',
    ownerExternalName: null,
    externalHandlerName: null,
    externalHandlerContactPerson: null,
    externalHandlerContactDetails: null,
    discoveredAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'u-admin',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'u-admin',
    lastUpdateAt: '2026-01-01T00:00:00.000Z',
    nextUpdateDue: null,
    noDeadlineReason: null,
    reportedToOps: 'no',
    reportedToOpsRecipient: null,
    reportedToComms: false,
    reportedToCommsRecipient: null,
    wisdomReported: false,
    wisdomIncidentNumber: null,
    closedAt: null,
    closedBy: null,
    rootCause: null,
    resolution: null,
    readinessAtClose: null,
    followUpNotes: null,
    followUpRequired: false,
    followUpCompletedAt: null,
    followUpCompletedBy: null,
    reopenCount: 0,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
    ...overrides,
  };
}

// Israel is on DST (UTC+3) in July, so 19.07.2026 16:05/16:06 local is
// 13:05/13:06 UTC. Picking a discoveredAt this far in the past (relative to
// whenever this suite actually runs) is what exercises the bug: the old
// `new Date()`-based calculation would report a duration of days/weeks --
// "now" minus discoveredAt -- instead of the fixed one-minute gap between
// the two chosen timestamps.
const DISCOVERED_AT = '2026-07-19T13:05:00.000Z';
const EFFECTIVE_CLOSURE_LOCAL = '2026-07-19T16:06'; // datetime-local value, Asia/Jerusalem wall clock

async function fillRequiredFieldsAndSetEventTime(user: ReturnType<typeof userEvent.setup>) {
  const timeField = screen.getByLabelText(/מועד סגירת התקלה בפועל/);
  fireEvent.change(timeField, { target: { value: EFFECTIVE_CLOSURE_LOCAL } });
  await user.type(screen.getByLabelText(/סיבת התקלה/), 'סיבה לבדיקה');
  await user.type(screen.getByLabelText(/הפתרון שבוצע/), 'פתרון לבדיקה');
  // Structured closure classification -- required on a full-readiness
  // close (the default readiness this dialog opens with). No-action-taken
  // is the simplest valid resolution-attribution choice for tests that
  // don't otherwise care about it.
  await user.selectOptions(screen.getByLabelText(/הגורם שאומת/), 'equipment');
  await user.selectOptions(screen.getByLabelText(/תוצאת הטיפול/), 'permanent_resolution');
  await user.selectOptions(screen.getByLabelText(/מה ידוע על מה שהוביל לפתרון/), 'no_action_taken');
}

describe('CloseDialog: duration reflects the selected effective closure time, not the current clock', () => {
  it('shows exactly one minute in the pre-confirm hint when closed one minute after discovery, regardless of the real current time', async () => {
    const user = userEvent.setup();
    const incident = makeIncident({ discoveredAt: DISCOVERED_AT });
    render(
      <CloseDialog open onClose={() => {}} incident={incident} onSubmit={() => {}} submitting={false} />,
    );

    await fillRequiredFieldsAndSetEventTime(user);

    expect(screen.getByText(/משך התקלה למועד הסגירה שנבחר:\s*דקה אחת/)).toBeInTheDocument();
  });

  it('shows exactly one minute in the confirmation dialog, matching the incident example (discovered 19.07.2026 16:05, closed 19.07.2026 16:06)', async () => {
    const user = userEvent.setup();
    const incident = makeIncident({ discoveredAt: DISCOVERED_AT });
    render(
      <CloseDialog open onClose={() => {}} incident={incident} onSubmit={() => {}} submitting={false} />,
    );

    await fillRequiredFieldsAndSetEventTime(user);
    await user.click(screen.getByRole('button', { name: 'המשך לאישור סגירה' }));

    expect(screen.getByText('משך התקלה:').parentElement).toHaveTextContent('משך התקלה: דקה אחת');
  });

  it('does not change when the closure is recorded much later (recorded_at/now must not affect the operational duration)', async () => {
    const user = userEvent.setup();
    const incident = makeIncident({ discoveredAt: DISCOVERED_AT });
    render(
      <CloseDialog open onClose={() => {}} incident={incident} onSubmit={() => {}} submitting={false} />,
    );

    await fillRequiredFieldsAndSetEventTime(user);
    await user.click(screen.getByRole('button', { name: 'המשך לאישור סגירה' }));

    // Simulates the report scenario: the confirmation dialog is being
    // reviewed on 02.08.2026, weeks after the incident actually closed.
    // The displayed duration must stay pinned to the chosen effective
    // closure time, not drift with however long the dialog stays open.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T10:00:00.000Z'));
    try {
      expect(screen.getByText('משך התקלה:').parentElement).toHaveTextContent('משך התקלה: דקה אחת');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CloseDialog: manual numeric editing of the closure time field is reliable', () => {
  // Before the fix, CloseDialog bound the field as
  // value={eventTime} onChange={(e) => setEventTime(e.target.value)} --
  // fully controlled. Every keystroke re-fires onChange with a complete
  // value, which re-renders and reassigns the native input's .value, and
  // browsers respond to that reassignment (even to an identical string) by
  // resetting the control's focused segment back to the first one --
  // corrupting whichever segment the user actually meant to edit next. This
  // reproduces with the regular number row and the numeric keypad alike,
  // which is exactly what these two tests exercise separately.
  it('changing the month with the regular number row does not corrupt the rest of the date, and the exact date/time submits correctly as ISO', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const incident = makeIncident({ discoveredAt: DISCOVERED_AT });
    render(<CloseDialog open onClose={() => {}} incident={incident} onSubmit={onSubmit} submitting={false} />);

    const timeField = screen.getByLabelText(/מועד סגירת התקלה בפועל/) as HTMLInputElement;
    fireEvent.change(timeField, { target: { value: '2026-01-19T16:06' } });
    fireEvent.change(timeField, { target: { value: '2026-07-19T16:06' } }); // month, top-row digits: 01 -> 07
    expect(timeField.value).toBe('2026-07-19T16:06');

    await user.type(screen.getByLabelText(/סיבת התקלה/), 'סיבה לבדיקה');
    await user.type(screen.getByLabelText(/הפתרון שבוצע/), 'פתרון לבדיקה');
    await user.selectOptions(screen.getByLabelText(/הגורם שאומת/), 'equipment');
    await user.selectOptions(screen.getByLabelText(/תוצאת הטיפול/), 'permanent_resolution');
    await user.selectOptions(screen.getByLabelText(/מה ידוע על מה שהוביל לפתרון/), 'no_action_taken');
    await user.click(screen.getByRole('button', { name: 'המשך לאישור סגירה' }));
    await user.click(screen.getByRole('button', { name: 'אישור סגירת תקלה' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ eventTime: '2026-07-19T13:06:00.000Z' }));
  });

  it('changing the month with the numeric keypad is equally reliable -- this is not a NumPad-specific bug', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const incident = makeIncident({ discoveredAt: DISCOVERED_AT });
    render(<CloseDialog open onClose={() => {}} incident={incident} onSubmit={onSubmit} submitting={false} />);

    const timeField = screen.getByLabelText(/מועד סגירת התקלה בפועל/) as HTMLInputElement;
    fireEvent.change(timeField, { target: { value: '2026-01-19T16:06' } });
    // The numeric keypad reports different KeyboardEvent.code values
    // ("Numpad0"/"Numpad7") than the number row, but the native control
    // resolves both to the same digit characters -- so the resulting
    // datetime-local value is identical either way.
    fireEvent.keyDown(timeField, { key: '0', code: 'Numpad0' });
    fireEvent.keyDown(timeField, { key: '7', code: 'Numpad7' });
    fireEvent.change(timeField, { target: { value: '2026-07-19T16:06' } }); // month, numpad digits: 01 -> 07
    expect(timeField.value).toBe('2026-07-19T16:06');

    await user.type(screen.getByLabelText(/סיבת התקלה/), 'סיבה לבדיקה');
    await user.type(screen.getByLabelText(/הפתרון שבוצע/), 'פתרון לבדיקה');
    await user.selectOptions(screen.getByLabelText(/הגורם שאומת/), 'equipment');
    await user.selectOptions(screen.getByLabelText(/תוצאת הטיפול/), 'permanent_resolution');
    await user.selectOptions(screen.getByLabelText(/מה ידוע על מה שהוביל לפתרון/), 'no_action_taken');
    await user.click(screen.getByRole('button', { name: 'המשך לאישור סגירה' }));
    await user.click(screen.getByRole('button', { name: 'אישור סגירת תקלה' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ eventTime: '2026-07-19T13:06:00.000Z' }));
  });

  it('editing day, month, year, hour, and minute one at a time never resets an unrelated segment, and a mid-edit empty value is ignored rather than clearing the field', () => {
    const incident = makeIncident({ discoveredAt: DISCOVERED_AT });
    render(<CloseDialog open onClose={() => {}} incident={incident} onSubmit={() => {}} submitting={false} />);
    const timeField = screen.getByLabelText(/מועד סגירת התקלה בפועל/) as HTMLInputElement;

    fireEvent.change(timeField, { target: { value: '2026-01-01T00:00' } });
    // Native datetime-local reports "" while a segment is only partially
    // typed -- this must never wipe out the rest of the already-typed date.
    fireEvent.change(timeField, { target: { value: '' } });
    expect(screen.getByText(/משך התקלה למועד הסגירה שנבחר:/)).toBeInTheDocument();

    fireEvent.change(timeField, { target: { value: '2026-01-19T00:00' } }); // day
    expect(timeField.value).toBe('2026-01-19T00:00');
    fireEvent.change(timeField, { target: { value: '2026-07-19T00:00' } }); // month
    expect(timeField.value).toBe('2026-07-19T00:00');
    fireEvent.change(timeField, { target: { value: '2027-07-19T00:00' } }); // year
    expect(timeField.value).toBe('2027-07-19T00:00');
    fireEvent.change(timeField, { target: { value: '2027-07-19T16:00' } }); // hour
    expect(timeField.value).toBe('2027-07-19T16:00');
    fireEvent.change(timeField, { target: { value: '2027-07-19T16:06' } }); // minute
    // Every earlier segment (day/month/year/hour) survived the later edits.
    expect(timeField.value).toBe('2027-07-19T16:06');
  });

  it('entering 19/07/2026 16:06 in one shot shows the correct duration and submits the correct ISO value', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const incident = makeIncident({ discoveredAt: DISCOVERED_AT });
    render(<CloseDialog open onClose={() => {}} incident={incident} onSubmit={onSubmit} submitting={false} />);

    const timeField = screen.getByLabelText(/מועד סגירת התקלה בפועל/) as HTMLInputElement;
    fireEvent.change(timeField, { target: { value: '2026-07-19T16:06' } });
    expect(screen.getByText(/משך התקלה למועד הסגירה שנבחר:\s*דקה אחת/)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/סיבת התקלה/), 'סיבה לבדיקה');
    await user.type(screen.getByLabelText(/הפתרון שבוצע/), 'פתרון לבדיקה');
    await user.selectOptions(screen.getByLabelText(/הגורם שאומת/), 'equipment');
    await user.selectOptions(screen.getByLabelText(/תוצאת הטיפול/), 'permanent_resolution');
    await user.selectOptions(screen.getByLabelText(/מה ידוע על מה שהוביל לפתרון/), 'no_action_taken');
    await user.click(screen.getByRole('button', { name: 'המשך לאישור סגירה' }));
    expect(screen.getByText('משך התקלה:').parentElement).toHaveTextContent('משך התקלה: דקה אחת');
    await user.click(screen.getByRole('button', { name: 'אישור סגירת תקלה' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ eventTime: '2026-07-19T13:06:00.000Z' }));
  });
});

describe('CloseDialog: "הערה נוספת" (optional note)', () => {
  it('is optional -- submits successfully with no note entered, and with a live character counter', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const incident = makeIncident({ discoveredAt: DISCOVERED_AT });
    render(<CloseDialog open onClose={() => {}} incident={incident} onSubmit={onSubmit} submitting={false} />);

    const noteField = screen.getByLabelText('הערה נוספת');
    expect(noteField).toHaveAttribute('maxLength', '600');
    expect(screen.getByText('0/600')).toBeInTheDocument();

    await fillRequiredFieldsAndSetEventTime(user);
    await user.click(screen.getByRole('button', { name: 'המשך לאישור סגירה' }));
    await user.click(screen.getByRole('button', { name: 'אישור סגירת תקלה' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ note: '' }));
  });

  it('passes an entered note through to onSubmit and updates the character counter', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const incident = makeIncident({ discoveredAt: DISCOVERED_AT });
    render(<CloseDialog open onClose={() => {}} incident={incident} onSubmit={onSubmit} submitting={false} />);

    await fillRequiredFieldsAndSetEventTime(user);
    await user.type(screen.getByLabelText('הערה נוספת'), 'הערה לבדיקה');
    expect(screen.getByText(`${'הערה לבדיקה'.length}/600`)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'המשך לאישור סגירה' }));
    await user.click(screen.getByRole('button', { name: 'אישור סגירת תקלה' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ note: 'הערה לבדיקה' }));
  });
});
