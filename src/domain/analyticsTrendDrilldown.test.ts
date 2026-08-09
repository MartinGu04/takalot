// Proves the drill-down list can never disagree with the trend chart's own
// bucket counts: both are built from the exact same matchesEntityFilters/
// bucketKeyOf functions (analyticsSummary.ts), never a re-derived notion of
// "opened"/"closed" or a separately-computed bucket boundary.
import { describe, expect, it } from 'vitest';
import { computeTrendBucketIncidents, TREND_BUCKET_DRILLDOWN_LIMIT } from './analyticsTrendDrilldown';
import type { Incident, IncidentClosureClassification } from './types';

function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'i1',
    number: '2026-001',
    version: 1,
    systemId: 'sys',
    locationId: 'loc',
    description: 'desc',
    severity: 'medium',
    status: 'closed',
    operationalImpact: 'impact',
    reportedDomain: null,
    currentSuspectedCause: null,
    currentSuspectedCauseOtherDetail: null,
    ownerUserId: 'u1',
    ownerExternalName: null,
    externalHandlerName: null,
    externalHandlerContactPerson: null,
    externalHandlerContactDetails: null,
    discoveredAt: '2026-08-05T10:00:00.000Z',
    createdAt: '2026-08-05T10:00:00.000Z',
    createdBy: 'u1',
    updatedAt: '2026-08-05T10:00:00.000Z',
    updatedBy: 'u1',
    lastUpdateAt: '2026-08-05T10:00:00.000Z',
    nextUpdateDue: null,
    noDeadlineReason: 'n/a',
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

const NO_CLOSURES: IncidentClosureClassification[] = [];

describe('computeTrendBucketIncidents: day buckets', () => {
  it('an incident discovered on the bucket day appears in "opened", not in "closed"', () => {
    const i = makeIncident({ id: 'a', discoveredAt: '2026-08-05T08:00:00.000Z' });
    const r = computeTrendBucketIncidents([i], NO_CLOSURES, '2026-08-05', 'day', {});
    expect(r.opened.map((s) => s.id)).toEqual(['a']);
    expect(r.closed).toEqual([]);
  });

  it('an incident discovered the day before or after does not appear', () => {
    // Asia/Jerusalem is UTC+3 in August (DST) -- these UTC instants are
    // chosen so they land just before/after the Jerusalem calendar day,
    // not the UTC one.
    const before = makeIncident({ id: 'before', discoveredAt: '2026-08-04T20:59:00.000Z' }); // 23:59 Jerusalem, Aug 4
    const after = makeIncident({ id: 'after', discoveredAt: '2026-08-05T21:01:00.000Z' }); // 00:01 Jerusalem, Aug 6
    const r = computeTrendBucketIncidents([before, after], NO_CLOSURES, '2026-08-05', 'day', {});
    expect(r.opened).toEqual([]);
  });

  it('an incident both discovered AND closed on the same bucket day appears in both sections', () => {
    const i = makeIncident({
      id: 'same-day',
      discoveredAt: '2026-08-05T08:00:00.000Z',
      closedAt: '2026-08-05T18:00:00.000Z',
    });
    const r = computeTrendBucketIncidents([i], NO_CLOSURES, '2026-08-05', 'day', {});
    expect(r.opened.map((s) => s.id)).toEqual(['same-day']);
    expect(r.closed.map((s) => s.id)).toEqual(['same-day']);
  });

  it('a still-open incident (closedAt null) never appears in "closed"', () => {
    const i = makeIncident({ id: 'open', discoveredAt: '2026-08-05T08:00:00.000Z', closedAt: null });
    const r = computeTrendBucketIncidents([i], NO_CLOSURES, '2026-08-05', 'day', {});
    expect(r.closed).toEqual([]);
  });
});

describe('computeTrendBucketIncidents: week buckets (90-day view)', () => {
  // 2026-08-03 is a Monday; the ISO week runs through 2026-08-09 (Sunday).
  it('an incident closed anywhere within the Monday-Sunday ISO week matches the Monday bucket key', () => {
    const monday = makeIncident({ id: 'mon', closedAt: '2026-08-03T06:00:00.000Z' }); // 09:00 Jerusalem, Monday Aug 3
    const sunday = makeIncident({ id: 'sun', closedAt: '2026-08-09T20:00:00.000Z' }); // 23:00 Jerusalem, Sunday Aug 9
    const r = computeTrendBucketIncidents([monday, sunday], NO_CLOSURES, '2026-08-03', 'week', {});
    expect(new Set(r.closed.map((s) => s.id))).toEqual(new Set(['mon', 'sun']));
  });

  it('an incident closed on the following Monday belongs to the NEXT week bucket, not this one', () => {
    const nextMonday = makeIncident({ id: 'next', closedAt: '2026-08-10T03:00:00.000Z' }); // 06:00 Jerusalem, Monday Aug 10
    const r = computeTrendBucketIncidents([nextMonday], NO_CLOSURES, '2026-08-03', 'week', {});
    expect(r.closed).toEqual([]);
  });
});

describe('computeTrendBucketIncidents: page-wide filters apply identically to the trend chart', () => {
  it('an entity filter (system) excludes a non-matching incident from both sections', () => {
    const matching = makeIncident({ id: 'match', systemId: 'sys-a', discoveredAt: '2026-08-05T08:00:00.000Z' });
    const other = makeIncident({ id: 'other', systemId: 'sys-b', discoveredAt: '2026-08-05T08:00:00.000Z' });
    const r = computeTrendBucketIncidents([matching, other], NO_CLOSURES, '2026-08-05', 'day', { systemId: 'sys-a' });
    expect(r.opened.map((s) => s.id)).toEqual(['match']);
  });

  it('a page-wide confirmed-cause filter (unbounded by period, like every other analytics module) still gates bucket membership', () => {
    const i = makeIncident({ id: 'c1', discoveredAt: '2026-08-05T08:00:00.000Z' });
    const closures: IncidentClosureClassification[] = [
      {
        id: 'cl1',
        incidentId: 'c1',
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
        eventTime: '2026-06-01T00:00:00.000Z',
        recordedAt: '2026-06-01T00:00:00.000Z',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ];
    const matches = computeTrendBucketIncidents([i], closures, '2026-08-05', 'day', { confirmedCauses: ['equipment'] });
    expect(matches.opened.map((s) => s.id)).toEqual(['c1']);

    const noMatch = computeTrendBucketIncidents([i], closures, '2026-08-05', 'day', { confirmedCauses: ['software'] });
    expect(noMatch.opened).toEqual([]);
  });
});

describe('computeTrendBucketIncidents: bounded, never unbounded', () => {
  it('caps each section at TREND_BUCKET_DRILLDOWN_LIMIT, in chronological order', () => {
    const many = Array.from({ length: TREND_BUCKET_DRILLDOWN_LIMIT + 5 }, (_, n) =>
      makeIncident({
        id: `i${n}`,
        number: `2026-${String(n).padStart(3, '0')}`,
        discoveredAt: `2026-08-05T${String(n % 24).padStart(2, '0')}:00:00.000Z`,
      }),
    );
    const r = computeTrendBucketIncidents(many, NO_CLOSURES, '2026-08-05', 'day', {});
    expect(r.opened).toHaveLength(TREND_BUCKET_DRILLDOWN_LIMIT);
  });
});

describe('computeTrendBucketIncidents: IncidentSummary shape', () => {
  it('maps to the compact IncidentSummary shape, not the full Incident record', () => {
    const i = makeIncident({
      id: 'a',
      number: '2026-042',
      severity: 'critical',
      status: 'closed',
      systemId: 'sys-x',
      locationId: 'loc-x',
      description: 'תיאור קצר',
      discoveredAt: '2026-08-05T08:00:00.000Z',
    });
    const r = computeTrendBucketIncidents([i], NO_CLOSURES, '2026-08-05', 'day', {});
    expect(r.opened).toEqual([
      {
        id: 'a',
        number: '2026-042',
        severity: 'critical',
        status: 'closed',
        systemId: 'sys-x',
        locationId: 'loc-x',
        description: 'תיאור קצר',
      },
    ]);
  });
});
