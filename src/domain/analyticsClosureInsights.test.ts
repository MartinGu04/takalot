// Mirrors supabase/tests/incident_closure_insights_rpc.sql's G6 scenario
// (see that file and migration 0051's closures_in_period CTE) so the
// demo/local repository's closure-insights agree with the production RPC's
// row-level confirmed-cause/treatment-outcome filter behavior. This suite
// proves the LOCAL/DEMO implementation is correct -- it says nothing about
// the actual production RPC, which is validated independently by the SQL
// suite.
import { describe, expect, it } from 'vitest';
import { computeIncidentClosureInsights } from './analyticsClosureInsights';
import type { AnalyticsFilters } from './analyticsSummary';
import type { Incident, IncidentClosureClassification, IncidentEvent } from './types';

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
    discoveredAt: daysAgo(70),
    createdAt: daysAgo(70),
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
    closedAt: daysAgo(1),
    closedBy: 'u1',
    rootCause: 'rc',
    resolution: 'res',
    readinessAtClose: 'full',
    followUpNotes: null,
    followUpRequired: false,
    followUpCompletedAt: null,
    followUpCompletedBy: null,
    reopenCount: 1,
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
    type: 'closed',
    actorId: 'u1',
    actorLabel: null,
    eventTime: daysAgo(1),
    serverTime: daysAgo(1),
    field: null,
    oldValue: null,
    newValue: null,
    note: null,
    userNote: null,
    refId: null,
    createdAt: daysAgo(1),
    operationId: null,
    ...overrides,
  };
}

function makeClosure(overrides: Partial<IncidentClosureClassification> = {}): IncidentClosureClassification {
  return {
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
    eventTime: daysAgo(1),
    recordedAt: daysAgo(1),
    createdAt: daysAgo(1),
    ...overrides,
  };
}

const baseFilters: AnalyticsFilters = { periodDays: 30 };

// G6 fixture: incident closes an OLDER cycle (70 days ago -- outside a
// 30-day period) with confirmedCause='equipment', is reopened, then closes
// again INSIDE the period (1 day ago) with confirmedCause='software' /
// treatmentOutcome='temporary_workaround'.
const g6Incident = makeIncident({ id: 'g6', reopenCount: 1 });
const g6Closures: IncidentClosureClassification[] = [
  makeClosure({ id: 'g6-c0', incidentId: 'g6', cycleNumber: 0, confirmedCause: 'equipment', treatmentOutcome: 'permanent_resolution', eventTime: daysAgo(70) }),
  makeClosure({ id: 'g6-c1', incidentId: 'g6', cycleNumber: 1, confirmedCause: 'software', treatmentOutcome: 'temporary_workaround', eventTime: daysAgo(1) }),
];
const g6Events: IncidentEvent[] = [
  makeEvent({ id: 'g6-e0', incidentId: 'g6', type: 'closed', eventTime: daysAgo(70) }),
  makeEvent({ id: 'g6-e1', incidentId: 'g6', type: 'reopened', eventTime: daysAgo(30) }),
  makeEvent({ id: 'g6-e2', incidentId: 'g6', type: 'closed', eventTime: daysAgo(1) }),
];

describe('computeIncidentClosureInsights: row-level confirmed-cause/treatment-outcome filter consistency (mirrors SQL G6)', () => {
  it('unfiltered: the in-period software/temporary_workaround closure counts normally', () => {
    const r = computeIncidentClosureInsights([g6Incident], g6Events, g6Closures, baseFilters, NOW);
    expect(r.structuredClosuresInPeriod).toBe(1);
    expect(r.confirmedCauseCounts).toEqual([{ value: 'software', count: 1 }]);
    expect(r.treatmentOutcomeCounts).toEqual([{ value: 'temporary_workaround', count: 1 }]);
  });

  it('filtered by confirmedCauses=[equipment] (matches only the older, out-of-period cycle): excludes the non-matching in-period closure', () => {
    const filters: AnalyticsFilters = { ...baseFilters, confirmedCauses: ['equipment'] };
    const r = computeIncidentClosureInsights([g6Incident], g6Events, g6Closures, filters, NOW);
    expect(r.structuredClosuresInPeriod).toBe(0);
    expect(r.confirmedCauseCounts).toEqual([]);
  });

  it('filtered by confirmedCauses=[equipment]: confirmedCauseCounts never surfaces the contradicting software cause', () => {
    const filters: AnalyticsFilters = { ...baseFilters, confirmedCauses: ['equipment'] };
    const r = computeIncidentClosureInsights([g6Incident], g6Events, g6Closures, filters, NOW);
    expect(r.confirmedCauseCounts.some((c) => c.value === 'software')).toBe(false);
  });

  it('filtered by confirmedCauses=[equipment]: totalClosureEventsInPeriod still counts the in-period closing action (page-wide coverage denominator, deliberately not row-filtered)', () => {
    const filters: AnalyticsFilters = { ...baseFilters, confirmedCauses: ['equipment'] };
    const r = computeIncidentClosureInsights([g6Incident], g6Events, g6Closures, filters, NOW);
    expect(r.totalClosureEventsInPeriod).toBe(1);
    expect(r.structuredClosuresInPeriod).toBeLessThanOrEqual(r.totalClosureEventsInPeriod);
  });

  it('filtered by treatmentOutcomes=[permanent_resolution] (the older cycle\'s outcome): excludes the non-matching in-period closure symmetrically', () => {
    const filters: AnalyticsFilters = { ...baseFilters, treatmentOutcomes: ['permanent_resolution'] };
    const r = computeIncidentClosureInsights([g6Incident], g6Events, g6Closures, filters, NOW);
    expect(r.structuredClosuresInPeriod).toBe(0);
    expect(r.treatmentOutcomeCounts.some((c) => c.value === 'temporary_workaround')).toBe(false);
  });

  it('filtered by confirmedCauses=[software] (the genuinely matching in-period cause): still counts it -- the fix does not over-suppress a real match', () => {
    const filters: AnalyticsFilters = { ...baseFilters, confirmedCauses: ['software'] };
    const r = computeIncidentClosureInsights([g6Incident], g6Events, g6Closures, filters, NOW);
    expect(r.structuredClosuresInPeriod).toBe(1);
    expect(r.confirmedCauseCounts).toEqual([{ value: 'software', count: 1 }]);
  });
});
