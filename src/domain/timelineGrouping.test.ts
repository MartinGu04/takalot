import { describe, expect, it } from 'vitest';
import { groupTimelineEvents, selectPrimaryEvent } from './timelineGrouping';
import type { IncidentEvent } from './types';

function ev(overrides: Partial<IncidentEvent> & { id: string }): IncidentEvent {
  return {
    incidentId: 'inc-1',
    type: 'update',
    actorId: 'u1',
    actorLabel: null,
    eventTime: '2026-01-10T08:00:00.000Z',
    serverTime: '2026-01-10T08:00:00.000Z',
    field: null,
    oldValue: null,
    newValue: null,
    note: null,
    refId: null,
    createdAt: '2026-01-10T08:00:00.000Z',
    operationId: null,
    ...overrides,
  };
}

describe('groupTimelineEvents: operationId partitioning', () => {
  it('groups every row sharing one non-null operationId into a single group', () => {
    const events = [
      ev({ id: 'e1', type: 'update', operationId: 'op-1', refId: 'upd-1' }),
      ev({ id: 'e2', type: 'status_change', operationId: 'op-1', field: 'status' }),
      ev({ id: 'e3', type: 'severity_change', operationId: 'op-1', field: 'severity' }),
    ];
    const groups = groupTimelineEvents(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].operationId).toBe('op-1');
    expect(groups[0].primary.id).toBe('e1');
    expect(groups[0].subordinates.map((e) => e.id)).toEqual(['e2', 'e3']);
  });

  it('never merges two operationId=null rows, even with identical eventTime and type', () => {
    const events = [
      ev({ id: 'e1', type: 'update', operationId: null, eventTime: '2025-01-01T00:00:00.000Z' }),
      ev({ id: 'e2', type: 'update', operationId: null, eventTime: '2025-01-01T00:00:00.000Z' }),
    ];
    const groups = groupTimelineEvents(events);
    expect(groups).toHaveLength(2);
    expect(groups[0].primary.id).toBe('e1');
    expect(groups[0].subordinates).toEqual([]);
    expect(groups[1].primary.id).toBe('e2');
    expect(groups[1].subordinates).toEqual([]);
  });

  it('does not merge a null-operationId row into a neighboring non-null group sharing its eventTime', () => {
    const events = [
      ev({ id: 'e1', type: 'update', operationId: null, eventTime: '2025-06-01T00:00:00.000Z' }),
      ev({ id: 'e2', type: 'update', operationId: 'op-1', eventTime: '2025-06-01T00:00:00.000Z' }),
      ev({ id: 'e3', type: 'status_change', operationId: 'op-1', eventTime: '2025-06-01T00:00:00.000Z' }),
    ];
    const groups = groupTimelineEvents(events);
    expect(groups).toHaveLength(2);
    expect(groups[0].subordinates).toEqual([]);
    expect(groups[1].subordinates.map((e) => e.id)).toEqual(['e3']);
  });

  it('preserves overall chronological group order (each group placed at its first appearance)', () => {
    const events = [
      ev({ id: 'e1', type: 'created', operationId: 'op-1', eventTime: '2025-01-01T00:00:00.000Z' }),
      ev({ id: 'e2', type: 'update', operationId: 'op-2', eventTime: '2025-01-02T00:00:00.000Z' }),
      ev({ id: 'e3', type: 'status_change', operationId: 'op-1', eventTime: '2025-01-01T00:00:00.000Z' }),
    ];
    const groups = groupTimelineEvents(events);
    expect(groups.map((g) => g.operationId)).toEqual(['op-1', 'op-2']);
  });

  it('a lone delta-type row (e.g. assign_incident) is its own group, primary = itself', () => {
    const events = [ev({ id: 'e1', type: 'assignment_change', operationId: 'op-1', field: 'owner' })];
    const groups = groupTimelineEvents(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].primary.id).toBe('e1');
    expect(groups[0].subordinates).toEqual([]);
  });
});

describe('selectPrimaryEvent: explicit priority + deterministic fallback', () => {
  it('picks the lone non-delta event as primary regardless of array position', () => {
    const events = [
      ev({ id: 'e1', type: 'deadline_change' }),
      ev({ id: 'e2', type: 'update', refId: 'upd-1' }),
      ev({ id: 'e3', type: 'reported_to_ops_change' }),
    ];
    expect(selectPrimaryEvent(events).id).toBe('e2');
  });

  it('created outranks its own secondary status_change and reported_to_ops_change', () => {
    const events = [
      ev({ id: 'e1', type: 'reported_to_ops_change' }),
      ev({ id: 'e2', type: 'status_change' }),
      ev({ id: 'e3', type: 'created' }),
    ];
    expect(selectPrimaryEvent(events).id).toBe('e3');
  });

  it('closed outranks reported_to_ops_change', () => {
    const events = [ev({ id: 'e1', type: 'reported_to_ops_change' }), ev({ id: 'e2', type: 'closed' })];
    expect(selectPrimaryEvent(events).id).toBe('e2');
  });

  it('cancelled outranks status_check_changed (auto-removed check)', () => {
    const events = [
      ev({ id: 'e1', type: 'status_check_changed', field: 'status_check_due' }),
      ev({ id: 'e2', type: 'cancelled' }),
    ];
    expect(selectPrimaryEvent(events).id).toBe('e2');
  });

  it('all-delta group (close_incident partial-readiness branch): status_change wins over reported_to_ops_change', () => {
    const events = [
      ev({ id: 'e1', type: 'reported_to_ops_change' }),
      ev({ id: 'e2', type: 'status_change', field: 'status', oldValue: 'in_progress', newValue: 'partial_readiness' }),
    ];
    const primary = selectPrimaryEvent(events);
    expect(primary.id).toBe('e2');
  });

  it('duplicate status_check_changed: the closing row (new_value null) is primary regardless of array order', () => {
    const closing = ev({ id: 'e-close', type: 'status_check_changed', field: 'status_check_due', oldValue: '2026-01-01T00:00:00.000Z', newValue: null });
    const opening = ev({ id: 'e-open', type: 'status_check_changed', field: 'status_check_due', oldValue: null, newValue: '2026-01-05T00:00:00.000Z' });

    expect(selectPrimaryEvent([closing, opening]).id).toBe('e-close');
    // Reversed input order must not change the outcome -- selection is
    // content-driven, never array-position-driven.
    expect(selectPrimaryEvent([opening, closing]).id).toBe('e-close');
  });

  it('a grouped status-check completion orders the next-scheduled row as the sole subordinate', () => {
    const closing = ev({ id: 'e-close', operationId: 'op-1', type: 'status_check_changed', oldValue: '2026-01-01T00:00:00.000Z', newValue: null });
    const opening = ev({ id: 'e-open', operationId: 'op-1', type: 'status_check_changed', oldValue: null, newValue: '2026-01-05T00:00:00.000Z' });
    const groups = groupTimelineEvents([opening, closing]); // deliberately DB-order-reversed
    expect(groups).toHaveLength(1);
    expect(groups[0].primary.id).toBe('e-close');
    expect(groups[0].subordinates.map((e) => e.id)).toEqual(['e-open']);
  });

  it('subordinate field-change order follows the fixed semantic priority, not array order', () => {
    const events = [
      ev({ id: 'e-deadline', type: 'deadline_change' }),
      ev({ id: 'e-ops', type: 'reported_to_ops_change' }),
      ev({ id: 'e-assign', type: 'assignment_change' }),
      ev({ id: 'e-update', type: 'update', refId: 'upd-1' }),
      ev({ id: 'e-severity', type: 'severity_change' }),
      ev({ id: 'e-status', type: 'status_change' }),
      ev({ id: 'e-impact', type: 'impact_change' }),
    ];
    const groups = groupTimelineEvents(events.map((e) => ({ ...e, operationId: 'op-1' })));
    expect(groups[0].primary.id).toBe('e-update');
    expect(groups[0].subordinates.map((e) => e.id)).toEqual([
      'e-status',
      'e-severity',
      'e-impact',
      'e-assign',
      'e-deadline',
      'e-ops',
    ]);
  });

  it('same-type tiebreak (defensive path never hit by current RPCs) is a stable id comparison, not array position', () => {
    const a = ev({ id: 'aaa', type: 'reported_to_ops_change' });
    const b = ev({ id: 'bbb', type: 'reported_to_ops_change' });
    expect(selectPrimaryEvent([b, a]).id).toBe('aaa');
    expect(selectPrimaryEvent([a, b]).id).toBe('aaa');
  });
});
