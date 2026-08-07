// תמונת מצב עדכנית -- pure selection logic. Covers active/reopen/closed/
// cancelled/legacy per the product spec; DOM/interaction is covered by
// components/CurrentStateSummary.test.tsx.
import { describe, expect, it } from 'vitest';
import { selectCurrentStateSummary } from './currentState';
import type { Incident, IncidentClosureClassification, IncidentEvent, IncidentUpdate } from './types';

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
    actionsTaken: 'פעולות',
    findings: '',
    nextSteps: '',
    currentStatusText: 'המערכת פעילה חלקית',
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

function makeClosure(overrides: Partial<IncidentClosureClassification> & { id: string }): IncidentClosureClassification {
  return {
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
    eventTime: '2026-01-02T00:00:00.000Z',
    recordedAt: '2026-01-02T00:00:00.000Z',
    createdAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('selectCurrentStateSummary: active incident', () => {
  it('a single current-status update is selected', () => {
    const incident = makeIncident();
    const update = makeUpdate({ id: 'u1', currentStatusText: 'ממתינים לבדיקת הגורם החיצוני' });
    const event = makeEvent({ id: 'e1', type: 'update', refId: 'u1', operationId: 'op1' });
    const result = selectCurrentStateSummary(incident, [update], [event], undefined);
    expect(result).toEqual({ kind: 'active', update, anchorId: 'op1' });
  });

  it('several updates: the latest qualifying one (by serverTime) is selected, not updates[0]', () => {
    const incident = makeIncident();
    const older = makeUpdate({ id: 'u1', serverTime: '2026-01-01T08:00:00.000Z', currentStatusText: 'ישן' });
    const newer = makeUpdate({ id: 'u2', serverTime: '2026-01-01T10:00:00.000Z', currentStatusText: 'חדש' });
    // Deliberately out of chronological order in the array, to prove the
    // selection is content-driven, not array-position-driven.
    const updates = [newer, older];
    const events = [
      makeEvent({ id: 'e2', type: 'update', refId: 'u2', operationId: 'op2' }),
      makeEvent({ id: 'e1', type: 'update', refId: 'u1', operationId: 'op1' }),
    ];
    const result = selectCurrentStateSummary(incident, updates, events, undefined);
    expect(result.kind).toBe('active');
    expect(result.kind === 'active' && result.update.id).toBe('u2');
    expect(result.kind === 'active' && result.anchorId).toBe('op2');
  });

  it('an update without current-status text does not replace the last meaningful state', () => {
    const incident = makeIncident();
    const withStatus = makeUpdate({ id: 'u1', serverTime: '2026-01-01T08:00:00.000Z', currentStatusText: 'המצב הנוכחי' });
    const withoutStatus = makeUpdate({ id: 'u2', serverTime: '2026-01-01T10:00:00.000Z', currentStatusText: null });
    const updates = [withStatus, withoutStatus];
    const events = [
      makeEvent({ id: 'e1', type: 'update', refId: 'u1', operationId: 'op1' }),
      makeEvent({ id: 'e2', type: 'update', refId: 'u2', operationId: 'op2' }),
    ];
    const result = selectCurrentStateSummary(incident, updates, events, undefined);
    expect(result.kind).toBe('active');
    expect(result.kind === 'active' && result.update.id).toBe('u1');
  });

  it('blank (whitespace-only) current-status text does not qualify', () => {
    const incident = makeIncident();
    const update = makeUpdate({ id: 'u1', currentStatusText: '   ' });
    const event = makeEvent({ id: 'e1', type: 'update', refId: 'u1' });
    const result = selectCurrentStateSummary(incident, [update], [event], undefined);
    expect(result.kind).toBe('no_update');
  });

  it('actor and timestamp on the result correspond to the selected update', () => {
    const incident = makeIncident();
    const update = makeUpdate({ id: 'u1', authorId: 'martin', eventTime: '2026-01-05T12:34:00.000Z' });
    const event = makeEvent({ id: 'e1', type: 'update', refId: 'u1' });
    const result = selectCurrentStateSummary(incident, [update], [event], undefined);
    expect(result.kind).toBe('active');
    expect(result.kind === 'active' && result.update.authorId).toBe('martin');
    expect(result.kind === 'active' && result.update.eventTime).toBe('2026-01-05T12:34:00.000Z');
  });
});

describe('selectCurrentStateSummary: no update yet', () => {
  it('an incident with no updates at all shows the no-update fallback', () => {
    const incident = makeIncident();
    const result = selectCurrentStateSummary(incident, [], [], undefined);
    expect(result).toEqual({ kind: 'no_update' });
  });
});

describe('selectCurrentStateSummary: reopened incident', () => {
  it('updated, closed, reopened, but not updated again -- the previous status is not shown', () => {
    const incident = makeIncident({ status: 'reopened', reopenCount: 1 });
    const preCloseUpdate = makeUpdate({
      id: 'u1',
      serverTime: '2026-01-01T09:00:00.000Z',
      currentStatusText: 'סטטוס מהמחזור הקודם',
    });
    const events = [
      makeEvent({ id: 'e1', type: 'update', refId: 'u1', serverTime: '2026-01-01T09:00:00.000Z' }),
      makeEvent({ id: 'e2', type: 'closed', serverTime: '2026-01-01T12:00:00.000Z' }),
      makeEvent({ id: 'e3', type: 'reopened', serverTime: '2026-01-02T08:00:00.000Z' }),
    ];
    const result = selectCurrentStateSummary(incident, [preCloseUpdate], events, undefined);
    expect(result).toEqual({ kind: 'no_update_since_reopen' });
  });

  it('a new update after reopen becomes the current summary', () => {
    const incident = makeIncident({ status: 'reopened', reopenCount: 1 });
    const preCloseUpdate = makeUpdate({
      id: 'u1',
      serverTime: '2026-01-01T09:00:00.000Z',
      currentStatusText: 'סטטוס מהמחזור הקודם',
    });
    const postReopenUpdate = makeUpdate({
      id: 'u2',
      serverTime: '2026-01-02T09:00:00.000Z',
      currentStatusText: 'סטטוס מהמחזור החדש',
    });
    const events = [
      makeEvent({ id: 'e1', type: 'update', refId: 'u1', serverTime: '2026-01-01T09:00:00.000Z' }),
      makeEvent({ id: 'e2', type: 'closed', serverTime: '2026-01-01T12:00:00.000Z' }),
      makeEvent({ id: 'e3', type: 'reopened', serverTime: '2026-01-02T08:00:00.000Z' }),
      makeEvent({ id: 'e4', type: 'update', refId: 'u2', serverTime: '2026-01-02T09:00:00.000Z', operationId: 'op4' }),
    ];
    const result = selectCurrentStateSummary(incident, [preCloseUpdate, postReopenUpdate], events, undefined);
    expect(result.kind).toBe('active');
    expect(result.kind === 'active' && result.update.id).toBe('u2');
    expect(result.kind === 'active' && result.anchorId).toBe('op4');
  });

  it('an update entered with a backdated eventTime but recorded (serverTime) after reopen still counts as current-cycle', () => {
    const incident = makeIncident({ status: 'reopened', reopenCount: 1 });
    // eventTime claims the update happened before the reopen, but it was
    // actually submitted (serverTime) after it -- serverTime must govern.
    const postReopenUpdate = makeUpdate({
      id: 'u2',
      eventTime: '2026-01-01T10:00:00.000Z',
      serverTime: '2026-01-02T09:00:00.000Z',
      currentStatusText: 'עדכון אמיתי אחרי הפתיחה מחדש',
    });
    const events = [
      makeEvent({ id: 'e3', type: 'reopened', serverTime: '2026-01-02T08:00:00.000Z' }),
      makeEvent({ id: 'e4', type: 'update', refId: 'u2', serverTime: '2026-01-02T09:00:00.000Z' }),
    ];
    const result = selectCurrentStateSummary(incident, [postReopenUpdate], events, undefined);
    expect(result.kind).toBe('active');
    expect(result.kind === 'active' && result.update.id).toBe('u2');
  });

  it('multiple reopen cycles: only updates since the MOST RECENT reopen qualify', () => {
    const incident = makeIncident({ status: 'in_progress', reopenCount: 2 });
    const cycle1Update = makeUpdate({ id: 'u1', serverTime: '2026-01-02T09:00:00.000Z', currentStatusText: 'מחזור 1' });
    const cycle2Update = makeUpdate({ id: 'u2', serverTime: '2026-01-04T09:00:00.000Z', currentStatusText: 'מחזור 2' });
    const events = [
      makeEvent({ id: 'e1', type: 'reopened', serverTime: '2026-01-02T08:00:00.000Z' }),
      makeEvent({ id: 'e2', type: 'update', refId: 'u1', serverTime: '2026-01-02T09:00:00.000Z' }),
      makeEvent({ id: 'e3', type: 'closed', serverTime: '2026-01-03T00:00:00.000Z' }),
      makeEvent({ id: 'e4', type: 'reopened', serverTime: '2026-01-04T08:00:00.000Z' }),
      makeEvent({ id: 'e5', type: 'update', refId: 'u2', serverTime: '2026-01-04T09:00:00.000Z', operationId: 'op5' }),
    ];
    const result = selectCurrentStateSummary(incident, [cycle1Update, cycle2Update], events, undefined);
    expect(result.kind).toBe('active');
    expect(result.kind === 'active' && result.update.id).toBe('u2');
  });
});

describe('selectCurrentStateSummary: closed incident', () => {
  it('shows the final closed state, never the last pre-closure active status', () => {
    const incident = makeIncident({ status: 'closed', closedAt: '2026-01-02T00:00:00.000Z', closedBy: 'sup-1' });
    const update = makeUpdate({ id: 'u1', currentStatusText: 'סטטוס לפני סגירה' });
    const events = [makeEvent({ id: 'e1', type: 'update', refId: 'u1' }), makeEvent({ id: 'e2', type: 'closed' })];
    const result = selectCurrentStateSummary(incident, [update], events, undefined);
    expect(result.kind).toBe('closed');
  });

  it('uses the latest closure cycle after reopen + second closure', () => {
    const incident = makeIncident({ status: 'closed', reopenCount: 1 });
    const firstClosure = makeClosure({ id: 'c0', cycleNumber: 0, treatmentOutcome: 'temporary_workaround' });
    const secondClosure = makeClosure({ id: 'c1', cycleNumber: 1, treatmentOutcome: 'permanent_resolution' });
    const result = selectCurrentStateSummary(incident, [], [], [firstClosure, secondClosure]);
    expect(result.kind).toBe('closed');
    expect(result.kind === 'closed' && result.closure?.id).toBe('c1');
  });

  it('treatment outcome is undefined (not fabricated) when no classification row matches', () => {
    const incident = makeIncident({ status: 'closed', reopenCount: 0 });
    const result = selectCurrentStateSummary(incident, [], [], []);
    expect(result.kind).toBe('closed');
    expect(result.kind === 'closed' && result.closure).toBeUndefined();
  });
});

describe('selectCurrentStateSummary: cancelled incident', () => {
  it('shows the cancelled state with no closure classification lookup', () => {
    const incident = makeIncident({
      status: 'cancelled',
      cancelledAt: '2026-01-02T00:00:00.000Z',
      cancelledBy: 'sup-1',
      cancellationReason: 'תקלה כפולה',
    });
    const closure = makeClosure({ id: 'c0', cycleNumber: 0 });
    const result = selectCurrentStateSummary(incident, [], [], [closure]);
    expect(result).toEqual({ kind: 'cancelled' });
  });
});

describe('selectCurrentStateSummary: legacy compatibility', () => {
  it('legacy active incident with updates shows the latest qualifying current state', () => {
    const incident = makeIncident({ reopenCount: 0 });
    const legacyUpdate = makeUpdate({ id: 'u1', currentStatusText: null });
    const modernUpdate = makeUpdate({ id: 'u2', serverTime: '2026-01-01T10:00:00.000Z', currentStatusText: 'עדכון מלא' });
    const result = selectCurrentStateSummary(incident, [legacyUpdate, modernUpdate], [], undefined);
    expect(result.kind).toBe('active');
    expect(result.kind === 'active' && result.update.id).toBe('u2');
  });

  it('legacy active incident with no current-status update ever recorded falls back to no_update', () => {
    const incident = makeIncident({ reopenCount: 0 });
    const legacyUpdate = makeUpdate({ id: 'u1', currentStatusText: null });
    const result = selectCurrentStateSummary(incident, [legacyUpdate], [], undefined);
    expect(result).toEqual({ kind: 'no_update' });
  });

  it('reopenCount > 0 but no reopened event locatable (anomalous/legacy data) fails closed, never leaking a stale update', () => {
    const incident = makeIncident({ status: 'in_progress', reopenCount: 1 });
    const update = makeUpdate({ id: 'u1', currentStatusText: 'עדכון ישן כלשהו' });
    const result = selectCurrentStateSummary(incident, [update], [], undefined);
    expect(result).toEqual({ kind: 'no_update_since_reopen' });
  });

  it('old closed incident with no classification data renders the closed state safely', () => {
    const incident = makeIncident({ status: 'closed', closedAt: '2020-01-01T00:00:00.000Z', closedBy: null, reopenCount: 0 });
    const result = selectCurrentStateSummary(incident, [], [], undefined);
    expect(result).toEqual({ kind: 'closed', closure: undefined });
  });

  it('old cancelled incident renders the cancelled state safely', () => {
    const incident = makeIncident({ status: 'cancelled', cancelledAt: null, cancelledBy: null, cancellationReason: null });
    const result = selectCurrentStateSummary(incident, [], [], undefined);
    expect(result).toEqual({ kind: 'cancelled' });
  });
});
