// תמונת מצב עדכנית -- component rendering + Timeline scroll/focus
// interaction. Selection-logic correctness (active/reopen/closed/cancelled/
// legacy) is covered by domain/currentState.test.ts; this file covers what
// actually reaches the screen and the click/keyboard interaction with the
// real Timeline component.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CurrentStateSummary } from './CurrentStateSummary';
import { Timeline } from './Timeline';
import type { Incident, IncidentEvent, IncidentUpdate, Profile } from '../domain/types';

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
    ownerUserId: 'tech-1',
    ownerExternalName: null,
    externalHandlerName: null,
    externalHandlerContactPerson: null,
    externalHandlerContactDetails: null,
    discoveredAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'sup-1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'sup-1',
    lastUpdateAt: '2026-01-01T00:00:00.000Z',
    nextUpdateDue: null,
    noDeadlineReason: 'x',
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

function makeUpdate(overrides: Partial<IncidentUpdate> & { id: string }): IncidentUpdate {
  return {
    incidentId: 'i1',
    authorId: 'u1',
    eventTime: '2026-01-01T09:00:00.000Z',
    serverTime: '2026-01-01T09:00:00.000Z',
    actionsTaken: 'פעולות שבוצעו',
    findings: '',
    nextSteps: '',
    currentStatusText: 'המערכת פעילה חלקית, ממתינים לבדיקת הגורם החיצוני.',
    updateReportedToOps: null,
    updateReportedToOpsRecipient: null,
    updateReportedToComms: null,
    updateReportedToCommsRecipient: null,
    updateWisdomReported: null,
    userNote: null,
    createdAt: '2026-01-01T09:00:00.000Z',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<IncidentEvent> & { id: string }): IncidentEvent {
  return {
    incidentId: 'i1',
    type: 'update',
    actorId: 'u1',
    actorLabel: null,
    eventTime: '2026-01-01T09:00:00.000Z',
    serverTime: '2026-01-01T09:00:00.000Z',
    field: null,
    oldValue: null,
    newValue: null,
    note: null,
    userNote: null,
    refId: null,
    createdAt: '2026-01-01T09:00:00.000Z',
    operationId: null,
    ...overrides,
  };
}

const profiles: Profile[] = [
  { id: 'u1', fullName: 'מרטין גוסין', role: 'shift_supervisor', active: true, createdAt: '2026-01-01T00:00:00.000Z' },
];

describe('CurrentStateSummary: rendering', () => {
  it('renders the section title and the active status text/actor', () => {
    const incident = makeIncident();
    const update = makeUpdate({ id: 'u1', currentStatusText: 'המערכת פעילה חלקית, ממתינים לבדיקת הגורם החיצוני.' });
    const event = makeEvent({ id: 'e1', refId: 'u1', operationId: 'op1' });
    render(<CurrentStateSummary incident={incident} updates={[update]} events={[event]} closures={undefined} profiles={profiles} />);
    expect(screen.getByText('תמונת מצב עדכנית')).toBeInTheDocument();
    expect(screen.getByText('המערכת פעילה חלקית, ממתינים לבדיקת הגורם החיצוני.')).toBeInTheDocument();
    expect(screen.getByText(/על ידי מרטין גוסין/)).toBeInTheDocument();
  });

  it('long current-status text wraps naturally (whitespace-pre-wrap/break-words, no truncation)', () => {
    const incident = makeIncident();
    const longText = 'טקסט ארוך מאוד המתאר את המצב המבצעי הנוכחי '.repeat(10).trim();
    const update = makeUpdate({ id: 'u1', currentStatusText: longText });
    const event = makeEvent({ id: 'e1', refId: 'u1' });
    render(<CurrentStateSummary incident={incident} updates={[update]} events={[event]} closures={undefined} profiles={profiles} />);
    const node = screen.getByText(longText);
    expect(node.className).toContain('whitespace-pre-wrap');
    expect(node.className).toContain('break-words');
  });

  it('no-update fallback shows the exact required Hebrew text, not a dash or placeholder', () => {
    const incident = makeIncident();
    render(<CurrentStateSummary incident={incident} updates={[]} events={[]} closures={undefined} profiles={profiles} />);
    expect(screen.getByText('טרם פורסם עדכון מצב')).toBeInTheDocument();
  });

  it('reopened-with-no-new-update fallback shows the reopen-specific text', () => {
    const incident = makeIncident({ status: 'reopened', reopenCount: 1 });
    const oldUpdate = makeUpdate({ id: 'u1', currentStatusText: 'ישן', serverTime: '2026-01-01T08:00:00.000Z' });
    const events = [
      makeEvent({ id: 'e1', refId: 'u1', serverTime: '2026-01-01T08:00:00.000Z' }),
      makeEvent({ id: 'e2', type: 'reopened', serverTime: '2026-01-02T00:00:00.000Z' }),
    ];
    render(<CurrentStateSummary incident={incident} updates={[oldUpdate]} events={events} closures={undefined} profiles={profiles} />);
    expect(screen.getByText('טרם פורסם עדכון מצב מאז הפתיחה מחדש')).toBeInTheDocument();
    expect(screen.queryByText('ישן')).not.toBeInTheDocument();
  });

  it('closed incident shows the final closed state, closure time/actor, and treatment outcome when available', () => {
    const incident = makeIncident({
      status: 'closed',
      closedAt: '2026-01-05T10:00:00.000Z',
      closedBy: 'u1',
      resolution: 'הוחלף רכיב תקול',
      reopenCount: 0,
    });
    render(
      <CurrentStateSummary
        incident={incident}
        updates={[]}
        events={[]}
        closures={[
          {
            id: 'c1',
            incidentId: 'i1',
            cycleNumber: 0,
            operationId: null,
            confirmedCause: 'equipment',
            confirmedCauseOtherDetail: null,
            treatmentOutcome: 'permanent_resolution',
            treatmentOutcomeOtherDetail: null,
            resolutionAttribution: 'specific_action',
            resolutionAttributionOtherDetail: null,
            resolutionActionIds: [],
            recordedBy: 'u1',
            eventTime: '2026-01-05T10:00:00.000Z',
            recordedAt: '2026-01-05T10:00:00.000Z',
            createdAt: '2026-01-05T10:00:00.000Z',
          },
        ]}
        profiles={profiles}
      />,
    );
    expect(screen.getByText('התקלה נסגרה')).toBeInTheDocument();
    expect(screen.getByText('הוחלף רכיב תקול')).toBeInTheDocument();
    expect(screen.getByText(/על ידי מרטין גוסין/)).toBeInTheDocument();
    expect(screen.getByText(/תוצאת הטיפול: פתרון קבוע/)).toBeInTheDocument();
  });

  it('closed incident with no classification row omits the treatment-outcome line rather than fabricating one', () => {
    const incident = makeIncident({ status: 'closed', closedAt: '2020-01-01T00:00:00.000Z', closedBy: null });
    render(<CurrentStateSummary incident={incident} updates={[]} events={[]} closures={undefined} profiles={profiles} />);
    expect(screen.getByText('התקלה נסגרה')).toBeInTheDocument();
    expect(screen.queryByText(/תוצאת הטיפול/)).not.toBeInTheDocument();
  });

  it('cancelled incident shows the cancellation reason and no closure classification', () => {
    const incident = makeIncident({
      status: 'cancelled',
      cancelledAt: '2026-01-03T00:00:00.000Z',
      cancelledBy: 'u1',
      cancellationReason: 'תקלה כפולה, כבר טופלה תחת מספר אחר',
    });
    render(<CurrentStateSummary incident={incident} updates={[]} events={[]} closures={undefined} profiles={profiles} />);
    expect(screen.getByText('התקלה בוטלה')).toBeInTheDocument();
    expect(screen.getByText('תקלה כפולה, כבר טופלה תחת מספר אחר')).toBeInTheDocument();
    expect(screen.queryByText(/תוצאת הטיפול/)).not.toBeInTheDocument();
  });
});

describe('CurrentStateSummary: interaction with Timeline', () => {
  it('clicking an active summary sourced from an update scrolls/focuses the matching Timeline entry', async () => {
    const user = userEvent.setup();
    const incident = makeIncident();
    const update = makeUpdate({ id: 'u1' });
    const event = makeEvent({ id: 'e1', refId: 'u1', operationId: 'op1' });

    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;

    render(
      <div>
        <CurrentStateSummary incident={incident} updates={[update]} events={[event]} closures={undefined} profiles={profiles} />
        <Timeline events={[event]} updates={[update]} profiles={profiles} />
      </div>,
    );

    const button = screen.getByRole('button', { name: /המערכת פעילה חלקית/ });
    await user.click(button);

    const target = document.getElementById('timeline-entry-op1');
    expect(target).not.toBeNull();
    expect(scrollSpy).toHaveBeenCalled();
    expect(document.activeElement).toBe(target);
  });

  it('keyboard activation (Enter on the focused summary button) triggers the same scroll/focus', async () => {
    const user = userEvent.setup();
    const incident = makeIncident();
    const update = makeUpdate({ id: 'u1' });
    const event = makeEvent({ id: 'e1', refId: 'u1', operationId: 'op1' });

    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;

    render(
      <div>
        <CurrentStateSummary incident={incident} updates={[update]} events={[event]} closures={undefined} profiles={profiles} />
        <Timeline events={[event]} updates={[update]} profiles={profiles} />
      </div>,
    );

    const button = screen.getByRole('button', { name: /המערכת פעילה חלקית/ });
    button.focus();
    await user.keyboard('{Enter}');

    const target = document.getElementById('timeline-entry-op1');
    expect(scrollSpy).toHaveBeenCalled();
    expect(document.activeElement).toBe(target);
  });

  it('a no-source-update state (e.g. closed) renders without an interactive button', () => {
    const incident = makeIncident({ status: 'closed', closedAt: '2026-01-01T00:00:00.000Z', closedBy: null });
    render(<CurrentStateSummary incident={incident} updates={[]} events={[]} closures={undefined} profiles={profiles} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
