// Mirrors the scenario coverage of supabase/tests/incident_analytics_rpc.sql
// (see that file and supabase/migrations/0036_incident_analytics_rpc.sql for
// the authoritative spec) so the demo/local repository's analytics agree
// with the production RPC's documented behavior. This suite proves the
// LOCAL/DEMO implementation is correct -- it says nothing about the actual
// production RPC, which is validated independently by the SQL suite.
import { describe, expect, it } from 'vitest';
import { computeIncidentAnalytics } from './analyticsSummary';
import type { AnalyticsFilters } from './analyticsSummary';
import type { Incident, IncidentEvent, SystemRecord } from './types';

const NOW = new Date('2026-08-02T10:00:00.000Z');

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

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
    ownerUserId: 'u1',
    ownerExternalName: null,
    externalHandlerName: null,
    externalHandlerContactPerson: null,
    externalHandlerContactDetails: null,
    discoveredAt: daysAgo(1),
    createdAt: daysAgo(1),
    createdBy: 'u1',
    updatedAt: daysAgo(1),
    updatedBy: 'u1',
    lastUpdateAt: daysAgo(1),
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

function makeEvent(overrides: Partial<IncidentEvent> = {}): IncidentEvent {
  return {
    id: 'e1',
    incidentId: 'i1',
    type: 'reopened',
    actorId: 'u1',
    actorLabel: null,
    eventTime: daysAgo(1),
    serverTime: daysAgo(1),
    field: null,
    oldValue: null,
    newValue: null,
    note: null,
    refId: null,
    createdAt: daysAgo(1),
    operationId: null,
    ...overrides,
  };
}

function makeSystem(id: string, name: string): SystemRecord {
  return { id, name, archived: false, displayOrder: 1, createdAt: daysAgo(400) };
}

const baseFilters: AnalyticsFilters = { periodDays: 30 };

describe('computeIncidentAnalytics: opened/closed grounding', () => {
  it('openedInPeriod uses discoveredAt, not createdAt', () => {
    const incidents = [
      makeIncident({ id: 'old-discovery', discoveredAt: daysAgo(400), createdAt: daysAgo(1) }),
      makeIncident({ id: 'recent-discovery', discoveredAt: daysAgo(1), createdAt: daysAgo(400) }),
    ];
    const r = computeIncidentAnalytics(incidents, [], [], baseFilters, NOW);
    expect(r.openedInPeriod).toBe(1);
  });

  it('closedInPeriod counts the effective (current) closedAt once, regardless of reopen history', () => {
    const incidents = [
      makeIncident({
        id: 'reopened-then-reclosed',
        status: 'closed',
        discoveredAt: daysAgo(10),
        closedAt: daysAgo(1),
        reopenCount: 1,
      }),
    ];
    const events = [
      makeEvent({ id: 'ev1', incidentId: 'reopened-then-reclosed', type: 'closed', eventTime: daysAgo(9) }),
      makeEvent({ id: 'ev2', incidentId: 'reopened-then-reclosed', type: 'reopened', eventTime: daysAgo(5) }),
      makeEvent({ id: 'ev3', incidentId: 'reopened-then-reclosed', type: 'closed', eventTime: daysAgo(1) }),
    ];
    const r = computeIncidentAnalytics(incidents, events, [], baseFilters, NOW);
    expect(r.closedInPeriod).toBe(1);
    expect(r.avgCloseMinutes).toBe(9 * 1440);
    expect(r.reopenedInPeriod).toBe(1);
  });

  it('a currently reopened incident (closedAt null) is never counted as closed, but counts as open', () => {
    const incidents = [makeIncident({ id: 'reopened', status: 'reopened', closedAt: null, discoveredAt: daysAgo(20) })];
    const events = [
      makeEvent({ id: 'ev1', incidentId: 'reopened', type: 'reopened', eventTime: daysAgo(15) }),
      makeEvent({ id: 'ev2', incidentId: 'reopened', type: 'reopened', eventTime: daysAgo(3) }),
    ];
    const r = computeIncidentAnalytics(incidents, events, [], baseFilters, NOW);
    expect(r.closedInPeriod).toBe(0);
    expect(r.currentlyOpen).toBe(1);
    // Reopened twice in-period -- still counted once, not twice.
    expect(r.reopenedInPeriod).toBe(1);
  });

  it('a cancelled incident counts as opened, never as closed, never as currently open', () => {
    const incidents = [
      makeIncident({ id: 'cancelled', status: 'cancelled', discoveredAt: daysAgo(10), cancelledAt: daysAgo(2), closedAt: null }),
    ];
    const r = computeIncidentAnalytics(incidents, [], [], baseFilters, NOW);
    expect(r.openedInPeriod).toBe(1);
    expect(r.closedInPeriod).toBe(0);
    expect(r.currentlyOpen).toBe(0);
  });
});

describe('computeIncidentAnalytics: currently-open metrics are period-independent', () => {
  it('currentlyOpen and avgOpenMinutes are identical for a 7-day and 90-day period', () => {
    const incidents = [makeIncident({ id: 'long-open', status: 'waiting_information', discoveredAt: daysAgo(200) })];
    const r7 = computeIncidentAnalytics(incidents, [], [], { periodDays: 7 }, NOW);
    const r90 = computeIncidentAnalytics(incidents, [], [], { periodDays: 90 }, NOW);
    expect(r7.currentlyOpen).toBe(1);
    expect(r7.currentlyOpen).toBe(r90.currentlyOpen);
    expect(r7.avgOpenMinutes).toBe(r90.avgOpenMinutes);
  });
});

describe('computeIncidentAnalytics: filters', () => {
  const incidents = [
    makeIncident({ id: 'a', systemId: 'sysA', locationId: 'locA', severity: 'critical', discoveredAt: daysAgo(1) }),
    makeIncident({ id: 'b', systemId: 'sysA', locationId: 'locB', severity: 'low', discoveredAt: daysAgo(1) }),
  ];

  it('system filter alone includes both fixtures', () => {
    const r = computeIncidentAnalytics(incidents, [], [], { periodDays: 30, systemId: 'sysA' }, NOW);
    expect(r.openedInPeriod).toBe(2);
  });

  it('system + location narrows to one', () => {
    const r = computeIncidentAnalytics(incidents, [], [], { periodDays: 30, systemId: 'sysA', locationId: 'locA' }, NOW);
    expect(r.openedInPeriod).toBe(1);
  });

  it('severity narrows to one', () => {
    const r = computeIncidentAnalytics(incidents, [], [], { periodDays: 30, severity: 'low' }, NOW);
    expect(r.openedInPeriod).toBe(1);
  });

  it('combined filters apply as AND, matching nothing here', () => {
    const r = computeIncidentAnalytics(
      incidents, [], [],
      { periodDays: 30, systemId: 'sysA', locationId: 'locB', severity: 'critical' },
      NOW,
    );
    expect(r.openedInPeriod).toBe(0);
  });
});

describe('computeIncidentAnalytics: durations', () => {
  it('avgCloseMinutes averages exactly, and is null (not 0) when nothing closed', () => {
    const incidents = [
      makeIncident({ id: 'c1', status: 'closed', discoveredAt: daysAgo(6), closedAt: daysAgo(2) }),
      makeIncident({ id: 'c2', status: 'closed', discoveredAt: daysAgo(6), closedAt: daysAgo(4) }),
    ];
    const r = computeIncidentAnalytics(incidents, [], [], baseFilters, NOW);
    expect(r.avgCloseMinutes).toBe(4320);
    expect(r.closedInPeriod).toBe(2);

    const rEmpty = computeIncidentAnalytics([makeIncident({ id: 'open-only' })], [], [], baseFilters, NOW);
    expect(rEmpty.avgCloseMinutes).toBeNull();
  });

  it('avgOpenMinutes clamps a future (clock-skew) discoveredAt to 0, and is null when the open set is empty', () => {
    const incidents = [
      makeIncident({ id: 'now', discoveredAt: NOW.toISOString() }),
      makeIncident({ id: 'skewed-future', discoveredAt: new Date(NOW.getTime() + 2 * 60_000).toISOString() }),
    ];
    const r = computeIncidentAnalytics(incidents, [], [], baseFilters, NOW);
    expect(r.avgOpenMinutes).toBe(0);

    const rEmpty = computeIncidentAnalytics([], [], [], baseFilters, NOW);
    expect(rEmpty.avgOpenMinutes).toBeNull();
    expect(rEmpty.currentlyOpen).toBe(0);
  });
});

describe('computeIncidentAnalytics: zero-filled buckets', () => {
  it('a 7-day period yields exactly 7 daily buckets, all zero, for a system with no incidents', () => {
    const r = computeIncidentAnalytics([], [], [], { periodDays: 7, systemId: 'ghost' }, NOW);
    expect(r.buckets).toHaveLength(7);
    expect(r.buckets.every((b) => b.opened === 0 && b.closed === 0)).toBe(true);
  });

  it('a 30-day period yields exactly 30 daily buckets, all zero', () => {
    const r = computeIncidentAnalytics([], [], [], { periodDays: 30, systemId: 'ghost' }, NOW);
    expect(r.buckets).toHaveLength(30);
    expect(r.buckets.every((b) => b.opened === 0 && b.closed === 0)).toBe(true);
  });

  it('a 90-day period yields zero-filled weekly buckets', () => {
    const r = computeIncidentAnalytics([], [], [], { periodDays: 90, systemId: 'ghost' }, NOW);
    expect(r.buckets.length).toBeGreaterThan(0);
    expect(r.buckets.every((b) => b.opened === 0 && b.closed === 0)).toBe(true);
  });

  it('the sum of bucketed opened counts equals openedInPeriod (no pre-period leakage into a partial first bucket)', () => {
    const incidents = [
      // Just before the 90-day window -- must be excluded from every bucket.
      makeIncident({ id: 'before', discoveredAt: new Date(NOW.getTime() - 91 * 86_400_000).toISOString() }),
      makeIncident({ id: 'inside', discoveredAt: daysAgo(10) }),
    ];
    const r = computeIncidentAnalytics(incidents, [], [], { periodDays: 90 }, NOW);
    const bucketSum = r.buckets.reduce((sum, b) => sum + b.opened, 0);
    expect(bucketSum).toBe(r.openedInPeriod);
    expect(r.openedInPeriod).toBe(1);
  });
});

describe('computeIncidentAnalytics: top systems', () => {
  it('excludes a system with zero incidents opened in the period, even if it has a currently-open incident', () => {
    const incidents = [makeIncident({ id: 'old', systemId: 'stale-system', status: 'in_progress', discoveredAt: daysAgo(200) })];
    const r = computeIncidentAnalytics(incidents, [], [makeSystem('stale-system', 'Stale System')], { periodDays: 90 }, NOW);
    expect(r.topSystems).toEqual([]);
  });

  it('ranks by openedInPeriod desc, currentlyOpen desc, then system name asc', () => {
    const inc = (id: string, systemId: string, status: Incident['status'] = 'in_progress') =>
      makeIncident({ id, systemId, status, discoveredAt: daysAgo(1) });
    const incidents = [
      inc('a1', 'sysA'), inc('a2', 'sysA'), inc('a3', 'sysA'), // sysA: opened=3, open=3
      inc('c1', 'sysC'), inc('c2', 'sysC'), // sysC: opened=2, open=2
      inc('d1', 'sysD'), inc('d2', 'sysD', 'cancelled'), // sysD: opened=2, open=1
      inc('alpha1', 'sysAlpha'), // opened=1, open=1
      inc('bravo1', 'sysBravo'), // opened=1, open=1 -- ties sysAlpha, resolved by name
    ];
    const systems = [
      makeSystem('sysA', 'Rank-A-System'),
      makeSystem('sysC', 'Rank-C-System'),
      makeSystem('sysD', 'Zulu-Rank-D-System'),
      makeSystem('sysAlpha', 'Alpha-Rank-System'),
      makeSystem('sysBravo', 'Bravo-Rank-System'),
    ];
    const r = computeIncidentAnalytics(incidents, [], systems, baseFilters, NOW);
    expect(r.topSystems.map((s) => s.systemName)).toEqual([
      'Rank-A-System',
      'Rank-C-System',
      'Zulu-Rank-D-System',
      'Alpha-Rank-System',
      'Bravo-Rank-System',
    ]);
  });
});
