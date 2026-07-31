import { describe, expect, it } from 'vitest';
import { priorityRank, sortByPriority } from './overdue';
import type { Incident } from './types';

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
    discoveredAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'u1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'u1',
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

describe('priority ranking (severity-only; the next-update-ETA concept was removed)', () => {
  it('ranks critical and high severity in one combined top tier, above everything else', () => {
    const critical = makeIncident({ severity: 'critical' });
    const high = makeIncident({ severity: 'high' });
    const medium = makeIncident({ severity: 'medium' });
    const low = makeIncident({ severity: 'low' });

    expect(priorityRank(critical)).toBe(priorityRank(high));
    expect(priorityRank(high)).toBeLessThan(priorityRank(medium));
    expect(priorityRank(medium)).toBe(priorityRank(low));
  });

  it('sorts a mixed list with critical/high first', () => {
    const low = makeIncident({ id: 'low', severity: 'low' });
    const critical = makeIncident({ id: 'crit', severity: 'critical' });
    const high = makeIncident({ id: 'high', severity: 'high' });
    const medium = makeIncident({ id: 'med', severity: 'medium' });

    // critical and high are a genuine tie (same rank, same discoveredAt/
    // createdAt) -- a stable sort preserves their relative input order, so
    // this only asserts the TIER boundary (top two vs bottom two), not an
    // arbitrary ordering within the tied tier.
    const sorted = sortByPriority([low, medium, high, critical]);
    expect(sorted.map((i) => i.id).slice(0, 2).sort()).toEqual(['crit', 'high']);
    expect(sorted.map((i) => i.id).slice(2)).toEqual(['low', 'med']);
  });

  it('within a tier, sorts by newest discovery time first', () => {
    const older = makeIncident({ id: 'older', severity: 'critical', discoveredAt: '2026-01-01T00:00:00.000Z' });
    const newer = makeIncident({ id: 'newer', severity: 'high', discoveredAt: '2026-01-01T02:00:00.000Z' });
    const sorted = sortByPriority([older, newer]);
    expect(sorted.map((i) => i.id)).toEqual(['newer', 'older']);
  });

  it('falls back to newest creation time when discovery time ties', () => {
    const a = makeIncident({
      id: 'a',
      severity: 'critical',
      discoveredAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T01:00:00.000Z',
    });
    const b = makeIncident({
      id: 'b',
      severity: 'critical',
      discoveredAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T02:00:00.000Z',
    });
    const sorted = sortByPriority([a, b]);
    expect(sorted.map((i) => i.id)).toEqual(['b', 'a']);
  });
});
