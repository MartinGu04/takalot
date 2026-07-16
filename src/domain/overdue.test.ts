import { describe, expect, it } from 'vitest';
import { isOverdue, overdueText, priorityRank, sortByPriority } from './overdue';
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
    discoveredAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'u1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'u1',
    lastUpdateAt: '2026-01-01T00:00:00.000Z',
    nextUpdateDue: '2026-01-01T04:00:00.000Z',
    noDeadlineReason: null,
    reportedToOps: 'no',
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
    ...overrides,
  };
}

describe('overdue calculations', () => {
  it('is not overdue when the deadline is in the future', () => {
    const now = new Date('2026-01-01T03:00:00.000Z');
    const incident = makeIncident({ nextUpdateDue: '2026-01-01T04:00:00.000Z' });
    expect(isOverdue(incident, now)).toBe(false);
  });

  it('is overdue when the deadline has passed and incident is open', () => {
    const now = new Date('2026-01-01T05:00:00.000Z');
    const incident = makeIncident({ nextUpdateDue: '2026-01-01T04:00:00.000Z' });
    expect(isOverdue(incident, now)).toBe(true);
  });

  it('is never overdue when there is no deadline', () => {
    const now = new Date('2026-01-01T10:00:00.000Z');
    const incident = makeIncident({ nextUpdateDue: null, noDeadlineReason: 'ממתין לבירור' });
    expect(isOverdue(incident, now)).toBe(false);
  });

  it('is never overdue once the incident is closed', () => {
    const now = new Date('2026-01-01T10:00:00.000Z');
    const incident = makeIncident({ status: 'closed', nextUpdateDue: '2026-01-01T04:00:00.000Z' });
    expect(isOverdue(incident, now)).toBe(false);
  });

  it('produces human Hebrew overdue phrasing in minutes and hours', () => {
    const now = new Date('2026-01-01T04:18:00.000Z');
    const incident = makeIncident({ nextUpdateDue: '2026-01-01T04:00:00.000Z' });
    expect(overdueText(incident, now)).toBe('העדכון באיחור של 18 דקות');

    const now2 = new Date('2026-01-01T07:30:00.000Z');
    expect(overdueText(incident, now2)).toBe('העדכון באיחור של 3 שעות ו־30 דקות');
  });

  it('ranks critical/high overdue as one combined tier, above other-overdue, above remaining critical/high', () => {
    const now = new Date('2026-01-01T05:00:00.000Z');
    const criticalOverdue = makeIncident({ severity: 'critical', nextUpdateDue: '2026-01-01T04:00:00.000Z' });
    const highOverdue = makeIncident({ severity: 'high', nextUpdateDue: '2026-01-01T04:00:00.000Z' });
    const mediumOverdue = makeIncident({ severity: 'medium', nextUpdateDue: '2026-01-01T04:00:00.000Z' });
    const criticalNotOverdue = makeIncident({ severity: 'critical', nextUpdateDue: '2026-01-01T06:00:00.000Z' });
    const mediumNotOverdue = makeIncident({ severity: 'medium', nextUpdateDue: '2026-01-01T06:00:00.000Z' });

    // critical overdue and high overdue share one tier now.
    expect(priorityRank(criticalOverdue, now)).toBe(priorityRank(highOverdue, now));
    expect(priorityRank(highOverdue, now)).toBeLessThan(priorityRank(mediumOverdue, now));
    expect(priorityRank(mediumOverdue, now)).toBeLessThan(priorityRank(criticalNotOverdue, now));
    expect(priorityRank(criticalNotOverdue, now)).toBeLessThan(priorityRank(mediumNotOverdue, now));
  });

  it('sorts a mixed list into the four required operational priority tiers', () => {
    const now = new Date('2026-01-01T05:00:00.000Z');
    const low = makeIncident({ id: 'low', severity: 'low', nextUpdateDue: '2026-01-01T08:00:00.000Z' });
    const criticalOverdue = makeIncident({ id: 'crit-od', severity: 'critical', nextUpdateDue: '2026-01-01T04:00:00.000Z' });
    const highNotOverdue = makeIncident({ id: 'high-not-od', severity: 'high', nextUpdateDue: '2026-01-01T06:00:00.000Z' });
    const mediumOverdue = makeIncident({ id: 'med-od', severity: 'medium', nextUpdateDue: '2026-01-01T04:30:00.000Z' });

    const sorted = sortByPriority([low, highNotOverdue, mediumOverdue, criticalOverdue], now);
    expect(sorted.map((i) => i.id)).toEqual(['crit-od', 'med-od', 'high-not-od', 'low']);
  });

  it('does not use opening/discovery time as the sole rule -- it only breaks ties within a tier', () => {
    const now = new Date('2026-01-01T05:00:00.000Z');
    // Older but overdue-critical must still outrank a newer, non-overdue-low incident.
    const olderCriticalOverdue = makeIncident({
      id: 'older-crit-od',
      severity: 'critical',
      discoveredAt: '2025-01-01T00:00:00.000Z',
      nextUpdateDue: '2026-01-01T04:00:00.000Z',
    });
    const newerLowNotOverdue = makeIncident({
      id: 'newer-low',
      severity: 'low',
      discoveredAt: '2026-01-01T04:59:00.000Z',
      nextUpdateDue: '2026-01-01T08:00:00.000Z',
    });
    const sorted = sortByPriority([newerLowNotOverdue, olderCriticalOverdue], now);
    expect(sorted.map((i) => i.id)).toEqual(['older-crit-od', 'newer-low']);
  });

  it('within a tier, sorts by newest discovery time first', () => {
    const now = new Date('2026-01-01T05:00:00.000Z');
    const olderOverdue = makeIncident({
      id: 'older',
      severity: 'critical',
      discoveredAt: '2026-01-01T00:00:00.000Z',
      nextUpdateDue: '2026-01-01T04:00:00.000Z',
    });
    const newerOverdue = makeIncident({
      id: 'newer',
      severity: 'high',
      discoveredAt: '2026-01-01T02:00:00.000Z',
      nextUpdateDue: '2026-01-01T04:00:00.000Z',
    });
    const sorted = sortByPriority([olderOverdue, newerOverdue], now);
    expect(sorted.map((i) => i.id)).toEqual(['newer', 'older']);
  });
});
