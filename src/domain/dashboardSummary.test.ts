import { describe, expect, it } from 'vitest';
import { summarizeDashboard } from './dashboardSummary';
import type { Incident } from './types';

const NOW = new Date('2026-01-10T12:00:00.000Z');

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
    discoveredAt: '2026-01-10T08:00:00.000Z',
    createdAt: '2026-01-10T08:00:00.000Z',
    createdBy: 'u1',
    updatedAt: '2026-01-10T08:00:00.000Z',
    updatedBy: 'u1',
    lastUpdateAt: '2026-01-10T08:00:00.000Z',
    nextUpdateDue: '2026-01-10T16:00:00.000Z',
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

describe('summarizeDashboard: metric grounding', () => {
  it('open/overdue/criticalOrHigh counts are exactly the real, defensible rules -- no invented logic', () => {
    const incidents = [
      makeIncident({ id: 'critical-overdue', severity: 'critical', nextUpdateDue: '2026-01-10T10:00:00.000Z' }), // open, overdue, critical
      makeIncident({ id: 'high-ok', severity: 'high', nextUpdateDue: '2026-01-10T18:00:00.000Z' }), // open, not overdue, high
      makeIncident({ id: 'medium-ok', severity: 'medium' }), // open, not overdue
      makeIncident({ id: 'closed-critical', severity: 'critical', status: 'closed', closedAt: '2026-01-09T00:00:00.000Z' }), // closed -- must not count as open/overdue
    ];
    const s = summarizeDashboard(incidents, NOW);
    expect(s.open.map((i) => i.id)).toEqual(['critical-overdue', 'high-ok', 'medium-ok']);
    expect(s.overdue.map((i) => i.id)).toEqual(['critical-overdue']);
    expect(s.criticalOrHigh.map((i) => i.id).sort()).toEqual(['critical-overdue', 'high-ok']);
  });

  it('a cancelled incident (Chapter 2 terminal status) is excluded from open/overdue/criticalOrHigh, but DOES appear in recentTerminal', () => {
    const incidents = [
      makeIncident({
        id: 'cancelled-critical',
        severity: 'critical',
        status: 'cancelled',
        nextUpdateDue: '2026-01-10T10:00:00.000Z',
        cancelledAt: '2026-01-09T00:00:00.000Z',
      }),
      makeIncident({ id: 'open1' }),
    ];
    const s = summarizeDashboard(incidents, NOW);
    expect(s.open.map((i) => i.id)).toEqual(['open1']);
    expect(s.overdue).toEqual([]);
    expect(s.criticalOrHigh).toEqual([]);
    // "נסגרו לאחרונה" covers every terminal outcome -- closed AND cancelled --
    // not literally status === 'closed'.
    expect(s.recentTerminal.map((i) => i.id)).toEqual(['cancelled-critical']);
  });
});

describe('summarizeDashboard: needsAttention / openRest -- no duplicate rendering', () => {
  it('needsAttention is open AND (critical OR overdue); openRest is every other open incident', () => {
    const incidents = [
      makeIncident({ id: 'c1', severity: 'critical' }), // critical, not overdue
      makeIncident({ id: 'h1', severity: 'high' }), // neither -- excluded
      makeIncident({ id: 'm1', severity: 'medium' }), // neither -- excluded
      makeIncident({ id: 'l1', severity: 'low' }), // neither -- excluded
    ];
    const s = summarizeDashboard(incidents, NOW);
    expect(s.needsAttention.map((i) => i.id)).toEqual(['c1']);
    expect(s.openRest.map((i) => i.id).sort()).toEqual(['h1', 'l1', 'm1']);
  });

  it('an overdue but non-critical incident qualifies for needsAttention too', () => {
    const incidents = [
      makeIncident({ id: 'overdue-medium', severity: 'medium', nextUpdateDue: '2026-01-10T10:00:00.000Z' }), // overdue
      makeIncident({ id: 'overdue-high', severity: 'high', nextUpdateDue: '2026-01-10T10:00:00.000Z' }), // overdue
      makeIncident({ id: 'not-overdue-high', severity: 'high' }), // high alone -- excluded
    ];
    const s = summarizeDashboard(incidents, NOW);
    expect(s.needsAttention.map((i) => i.id).sort()).toEqual(['overdue-high', 'overdue-medium']);
    expect(s.openRest.map((i) => i.id)).toEqual(['not-overdue-high']);
  });

  it('no incident id ever appears in both needsAttention and openRest', () => {
    const incidents = [
      makeIncident({ id: 'c1', severity: 'critical' }),
      makeIncident({ id: 'c2', severity: 'critical' }),
      makeIncident({ id: 'overdue1', severity: 'low', nextUpdateDue: '2026-01-10T10:00:00.000Z' }),
      makeIncident({ id: 'h1', severity: 'high' }),
    ];
    const s = summarizeDashboard(incidents, NOW);
    const needsAttentionIds = new Set(s.needsAttention.map((i) => i.id));
    const overlap = s.openRest.filter((i) => needsAttentionIds.has(i.id));
    expect(overlap).toEqual([]);
  });

  it('high severity alone (not overdue, not critical) does not qualify for needsAttention (distinct from the criticalOrHigh stat)', () => {
    const incidents = [makeIncident({ id: 'h1', severity: 'high' })];
    const s = summarizeDashboard(incidents, NOW);
    expect(s.needsAttention).toEqual([]);
    expect(s.openRest.map((i) => i.id)).toEqual(['h1']);
    expect(s.criticalOrHigh.map((i) => i.id)).toEqual(['h1']);
  });

  it('when every open incident is critical, openRest is empty (not padded with anything)', () => {
    const incidents = [makeIncident({ id: 'c1', severity: 'critical' }), makeIncident({ id: 'c2', severity: 'critical' })];
    const s = summarizeDashboard(incidents, NOW);
    expect(s.needsAttention.map((i) => i.id).sort()).toEqual(['c1', 'c2']);
    expect(s.openRest).toEqual([]);
  });
});

describe('summarizeDashboard: recentTerminal', () => {
  it('includes only closed incidents, newest closedAt first, capped at the limit', () => {
    const incidents = [
      makeIncident({ id: 'open1', status: 'in_progress' }),
      makeIncident({ id: 'closed-old', status: 'closed', closedAt: '2026-01-01T00:00:00.000Z' }),
      makeIncident({ id: 'closed-new', status: 'closed', closedAt: '2026-01-08T00:00:00.000Z' }),
      makeIncident({ id: 'closed-mid', status: 'closed', closedAt: '2026-01-05T00:00:00.000Z' }),
    ];
    const s = summarizeDashboard(incidents, NOW);
    expect(s.recentTerminal.map((i) => i.id)).toEqual(['closed-new', 'closed-mid', 'closed-old']);
  });

  it('interleaves closed and cancelled incidents by their own terminal timestamp, newest first', () => {
    const incidents = [
      makeIncident({ id: 'closed-old', status: 'closed', closedAt: '2026-01-01T00:00:00.000Z' }),
      makeIncident({ id: 'cancelled-newest', status: 'cancelled', cancelledAt: '2026-01-09T00:00:00.000Z' }),
      makeIncident({ id: 'closed-mid', status: 'closed', closedAt: '2026-01-05T00:00:00.000Z' }),
      makeIncident({ id: 'cancelled-old', status: 'cancelled', cancelledAt: '2026-01-02T00:00:00.000Z' }),
    ];
    const s = summarizeDashboard(incidents, NOW);
    expect(s.recentTerminal.map((i) => i.id)).toEqual([
      'cancelled-newest',
      'closed-mid',
      'cancelled-old',
      'closed-old',
    ]);
  });

  it('caps at the given limit (3-5 useful items, not the whole archive)', () => {
    const incidents = Array.from({ length: 8 }, (_, n) =>
      makeIncident({ id: `closed-${n}`, status: 'closed', closedAt: `2026-01-0${(n % 9) + 1}T00:00:00.000Z` }),
    );
    const s = summarizeDashboard(incidents, NOW, 5);
    expect(s.recentTerminal.length).toBe(5);
  });
});

describe('summarizeDashboard: empty states', () => {
  it('no incidents at all -> every list is empty', () => {
    const s = summarizeDashboard([], NOW);
    expect(s.open).toEqual([]);
    expect(s.overdue).toEqual([]);
    expect(s.criticalOrHigh).toEqual([]);
    expect(s.needsAttention).toEqual([]);
    expect(s.openRest).toEqual([]);
    expect(s.recentTerminal).toEqual([]);
  });

  it('open incidents exist but none are critical -> needsAttention is empty, openRest holds everything open', () => {
    const incidents = [makeIncident({ id: 'h1', severity: 'high' }), makeIncident({ id: 'm1', severity: 'medium' })];
    const s = summarizeDashboard(incidents, NOW);
    expect(s.needsAttention).toEqual([]);
    expect(s.openRest.map((i) => i.id).sort()).toEqual(['h1', 'm1']);
  });

  it('no closed or cancelled incidents -> recentTerminal is empty', () => {
    const incidents = [makeIncident({ id: 'o1' })];
    const s = summarizeDashboard(incidents, NOW);
    expect(s.recentTerminal).toEqual([]);
  });

  it('exactly one open incident is handled without special-casing', () => {
    const s = summarizeDashboard([makeIncident({ id: 'only', severity: 'critical' })], NOW);
    expect(s.needsAttention.map((i) => i.id)).toEqual(['only']);
    expect(s.open.map((i) => i.id)).toEqual(['only']);
  });
});
