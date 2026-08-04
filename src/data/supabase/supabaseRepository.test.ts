// SupabaseRepository's shared RPC error mapping (`wrap`): every protected
// RPC (update_incident, create_incident, etc.) raises 'validation: ...' and
// some raise 'not_found: ...' using the project's controlled-error
// convention. Before this test existed, neither prefix had its own branch,
// so both fell through to the generic NETWORK fallback and were shown to
// the user with a leaked internal prefix, mislabeled as a communication
// error (e.g. "שגיאת תקשורת מול השרת: validation: ..."). These tests exercise
// the real code path (SupabaseRepository -> private rpc() -> wrap()) through
// a minimal fake Supabase client, not by re-implementing the mapping.
import { describe, expect, it } from 'vitest';
import { SupabaseRepository } from './supabaseRepository';
import { AppError } from '../repository';
import type { Session } from '../repository';
import type { UpdateIncidentInput } from '../../domain/schemas';

const session: Session = { userId: '00000000-0000-0000-0000-000000000001', role: 'system_admin' };

function repoWithRpcError(message: string): SupabaseRepository {
  const fakeClient = {
    rpc: async () => ({ data: null, error: { message } }),
  };
  return new SupabaseRepository(fakeClient as unknown as ConstructorParameters<typeof SupabaseRepository>[0]);
}

const dummyUpdateInput = {} as UpdateIncidentInput;

describe('SupabaseRepository RPC error mapping (wrap)', () => {
  it('maps a validation: prefixed error to AppError VALIDATION with the prefix stripped', async () => {
    const repo = repoWithRpcError('validation: יש להזין מועד עדכון בפועל');
    await expect(repo.updateIncident(session, 'inc-1', dummyUpdateInput)).rejects.toMatchObject({
      code: 'VALIDATION',
      message: 'יש להזין מועד עדכון בפועל',
    });
  });

  it('maps a not_found: prefixed error to AppError NOT_FOUND with the prefix stripped', async () => {
    const repo = repoWithRpcError('not_found: התקלה לא נמצאה');
    await expect(repo.updateIncident(session, 'inc-1', dummyUpdateInput)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'התקלה לא נמצאה',
    });
  });

  it('never classifies a validation or not_found error as a network failure, and never leaks the internal prefix', async () => {
    for (const message of ['validation: מועד העדכון בפועל אינו תקין', 'not_found: התקלה לא נמצאה']) {
      const repo = repoWithRpcError(message);
      try {
        await repo.updateIncident(session, 'inc-1', dummyUpdateInput);
        throw new Error('expected rejection');
      } catch (err) {
        const appError = err as AppError;
        expect(appError.code).not.toBe('NETWORK');
        expect(appError.message).not.toMatch(/שגיאת תקשורת/);
        expect(appError.message).not.toMatch(/^(validation|not_found):/);
      }
    }
  });

  it('still maps version_conflict/invalid_transition/permission unchanged (regression guard)', async () => {
    await expect(
      repoWithRpcError('version_conflict: התקלה עודכנה על ידי משתמש אחר').updateIncident(
        session, 'inc-1', dummyUpdateInput,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      repoWithRpcError('invalid_transition: מעבר הסטטוס אינו מותר').updateIncident(
        session, 'inc-1', dummyUpdateInput,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION', message: 'מעבר הסטטוס אינו מותר' });
    await expect(
      repoWithRpcError('permission: אין הרשאה לעדכן תקלה').updateIncident(session, 'inc-1', dummyUpdateInput),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('maps controlled reference-data conflicts without leaking the internal prefix', async () => {
    await expect(
      repoWithRpcError('conflict: כבר קיימת מערכת / עמדה בשם זה').createSystem(session, 'שם', 'other'),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'כבר קיימת מערכת / עמדה בשם זה',
    });
  });

  it('keeps permission, validation, conflict, and not-found mapping on reference-data RPCs', async () => {
    await expect(
      repoWithRpcError('permission: אין הרשאה לנהל מערכות ומיקומים').createLocation(session, 'שם', 'other'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      repoWithRpcError('validation: כיוון ההזזה אינו תקין').moveSystem(session, 'system-1', 'up'),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: 'כיוון ההזזה אינו תקין' });
    await expect(
      repoWithRpcError('conflict: כבר קיים מיקום בשם זה').renameLocation(session, 'location-1', 'שם'),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'כבר קיים מיקום בשם זה' });
    await expect(
      repoWithRpcError('not_found: המערכת / העמדה לא נמצאה').deleteSystem(session, 'system-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'המערכת / העמדה לא נמצאה' });
    await expect(
      repoWithRpcError('validation: סוג מערכת / עמדה אינו תקין').setSystemCategory(session, 'system-1', 'other'),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: 'סוג מערכת / עמדה אינו תקין' });
    await expect(
      repoWithRpcError('validation: סוג מיקום אינו תקין').setLocationCategory(session, 'location-1', 'other'),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: 'סוג מיקום אינו תקין' });
  });

  it('sanitizes unexpected PostgreSQL details only on reference-data RPCs', async () => {
    const raw = 'duplicate key value violates unique constraint systems_name_normalized_unique (SQLSTATE 23505)';
    try {
      await repoWithRpcError(raw).createSystem(session, 'שם', 'other');
      throw new Error('expected rejection');
    } catch (error) {
      const appError = error as AppError;
      expect(appError.code).toBe('NETWORK');
      expect(appError.message).not.toContain(raw);
      expect(appError.message).not.toMatch(/23505|constraint|systems_name_normalized_unique/i);
    }
  });

  it('retains the previous unexpected-error fallback for unrelated repository operations', async () => {
    const raw = 'upstream diagnostic for an existing incident RPC';
    await expect(
      repoWithRpcError(raw).updateIncident(session, 'inc-1', dummyUpdateInput),
    ).rejects.toMatchObject({
      code: 'NETWORK',
      message: `שגיאת תקשורת מול השרת: ${raw}`,
    });
  });

  it('does not apply the reference-data conflict mapping to unrelated repository operations', async () => {
    const raw = 'conflict: unrelated repository conflict detail';
    await expect(
      repoWithRpcError(raw).updateIncident(session, 'inc-1', dummyUpdateInput),
    ).rejects.toMatchObject({
      code: 'NETWORK',
      message: `שגיאת תקשורת מול השרת: ${raw}`,
    });
  });
});

describe('SupabaseRepository reference-data RPC parity', () => {
  it('uses narrow RPCs and maps display_order into domain records', async () => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const fakeClient = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        if (fn === 'create_system') {
          return {
            data: {
              id: 'system-1',
              name: 'מערכת',
              archived: false,
              category: 'computing',
              display_order: 7,
              created_at: '2026-07-29T10:00:00.000Z',
            },
            error: null,
          };
        }
        if (fn === 'delete_system') return { data: 'deleted', error: null };
        return { data: null, error: null };
      },
    };
    const repo = new SupabaseRepository(
      fakeClient as unknown as ConstructorParameters<typeof SupabaseRepository>[0],
    );

    await expect(repo.createSystem(session, ' מערכת ', 'computing')).resolves.toMatchObject({
      id: 'system-1',
      category: 'computing',
      displayOrder: 7,
    });
    await repo.renameSystem(session, 'system-1', 'שם חדש');
    await repo.setSystemArchived(session, 'system-1', true);
    await repo.moveSystem(session, 'system-1', 'down');
    await repo.setSystemCategory(session, 'system-1', 'infrastructure');
    await expect(repo.deleteSystem(session, 'system-1')).resolves.toBe('deleted');

    expect(calls).toEqual([
      { fn: 'create_system', args: { p_name: ' מערכת ', p_category: 'computing' } },
      { fn: 'rename_system', args: { p_system_id: 'system-1', p_name: 'שם חדש' } },
      { fn: 'set_system_active', args: { p_system_id: 'system-1', p_active: false } },
      { fn: 'move_system', args: { p_system_id: 'system-1', p_direction: 'down' } },
      { fn: 'set_system_category', args: { p_system_id: 'system-1', p_category: 'infrastructure' } },
      { fn: 'delete_system', args: { p_system_id: 'system-1' } },
    ]);
  });

  it('routes all location mutations through the matching authenticated RPC surface', async () => {
    const calls: string[] = [];
    const fakeClient = {
      rpc: async (fn: string) => {
        calls.push(fn);
        if (fn === 'create_location') {
          return {
            data: {
              id: 'location-1',
              name: 'מיקום',
              archived: false,
              category: 'field_side',
              display_order: 4,
              created_at: '2026-07-29T10:00:00.000Z',
            },
            error: null,
          };
        }
        if (fn === 'delete_location') return { data: 'archived', error: null };
        return { data: null, error: null };
      },
    };
    const repo = new SupabaseRepository(
      fakeClient as unknown as ConstructorParameters<typeof SupabaseRepository>[0],
    );

    await repo.createLocation(session, 'מיקום', 'field_side');
    await repo.renameLocation(session, 'location-1', 'מיקום חדש');
    await repo.setLocationArchived(session, 'location-1', false);
    await repo.moveLocation(session, 'location-1', 'up');
    await repo.setLocationCategory(session, 'location-1', 'external_sites');
    await expect(repo.deleteLocation(session, 'location-1')).resolves.toBe('archived');

    expect(calls).toEqual([
      'create_location',
      'rename_location',
      'set_location_active',
      'move_location',
      'set_location_category',
      'delete_location',
    ]);
  });

  it('sends a single batch RPC call for reorderSystems/reorderLocations with the full ordered id list', async () => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const fakeClient = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return { data: null, error: null };
      },
    };
    const repo = new SupabaseRepository(
      fakeClient as unknown as ConstructorParameters<typeof SupabaseRepository>[0],
    );

    await repo.reorderSystems(session, ['system-3', 'system-1', 'system-2']);
    await repo.reorderLocations(session, ['location-2', 'location-1']);

    expect(calls).toEqual([
      { fn: 'reorder_systems', args: { p_ids: ['system-3', 'system-1', 'system-2'] } },
      { fn: 'reorder_locations', args: { p_ids: ['location-2', 'location-1'] } },
    ]);
  });

  it('maps permission/validation errors from the reorder RPCs like every other reference-data RPC', async () => {
    await expect(
      repoWithRpcError('permission: אין הרשאה לנהל מערכות ומיקומים').reorderSystems(session, ['a']),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      repoWithRpcError('validation: רשימת הסידור מכילה מזהים כפולים').reorderLocations(session, ['a', 'a']),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      message: 'רשימת הסידור מכילה מזהים כפולים',
    });
  });
});

describe('SupabaseRepository.countClosedIncidents', () => {
  function repoWithCountQuery(capture: { table?: string; select?: unknown[]; eq?: unknown[] }, result: {
    count: number | null;
    error?: { message: string } | null;
  }): SupabaseRepository {
    const builder = {
      select: (...args: unknown[]) => {
        capture.select = args;
        return builder;
      },
      eq: (...args: unknown[]) => {
        capture.eq = args;
        return Promise.resolve({ count: result.count, error: result.error ?? null });
      },
    };
    const fakeClient = {
      from: (table: string) => {
        capture.table = table;
        return builder;
      },
    };
    return new SupabaseRepository(fakeClient as unknown as ConstructorParameters<typeof SupabaseRepository>[0]);
  }

  it('asks PostgREST for an exact count of status = closed, transferring no rows', async () => {
    const capture: { table?: string; select?: unknown[]; eq?: unknown[] } = {};
    const repo = repoWithCountQuery(capture, { count: 137 });

    expect(await repo.countClosedIncidents(session)).toBe(137);
    expect(capture.table).toBe('incidents');
    // head: true means no rows come back, so the 500-row list cap that
    // listIncidents applies plays no part in this number.
    expect(capture.select?.[1]).toEqual({ count: 'exact', head: true });
    // Literally 'closed' -- a cancelled incident is a different terminal
    // outcome and is never counted.
    expect(capture.eq).toEqual(['status', 'closed']);
  });

  it('reports zero rather than null when the project has no closed incidents', async () => {
    const repo = repoWithCountQuery({}, { count: null });
    expect(await repo.countClosedIncidents(session)).toBe(0);
  });

  it('surfaces a query failure through the shared error mapping', async () => {
    const repo = repoWithCountQuery({}, { count: null, error: { message: 'permission: אין הרשאה' } });
    await expect(repo.countClosedIncidents(session)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('SupabaseRepository.getIncidentEvents: operation_id mapping', () => {
  function repoWithEventsQuery(rows: Record<string, unknown>[]): SupabaseRepository {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => Promise.resolve({ data: rows, error: null }),
    };
    const fakeClient = { from: () => builder };
    return new SupabaseRepository(fakeClient as unknown as ConstructorParameters<typeof SupabaseRepository>[0]);
  }

  const baseRow = {
    id: 'ev-1',
    incident_id: 'inc-1',
    type: 'update',
    actor_id: 'u1',
    actor_label: null,
    event_time: '2026-01-01T00:00:00Z',
    server_time: '2026-01-01T00:00:00Z',
    field: null,
    old_value: null,
    new_value: null,
    note: null,
    ref_id: null,
    created_at: '2026-01-01T00:00:00Z',
  };

  it('maps a populated operation_id column through to operationId', async () => {
    const repo = repoWithEventsQuery([{ ...baseRow, operation_id: 'op-123' }]);
    const events = await repo.getIncidentEvents(session, 'inc-1');
    expect(events[0].operationId).toBe('op-123');
  });

  it('maps a null operation_id (historical row) to null, not undefined', async () => {
    const repo = repoWithEventsQuery([{ ...baseRow, operation_id: null }]);
    const events = await repo.getIncidentEvents(session, 'inc-1');
    expect(events[0].operationId).toBeNull();
  });

  it('maps a missing operation_id key (defensive) to null rather than leaking undefined', async () => {
    const repo = repoWithEventsQuery([{ ...baseRow }]);
    const events = await repo.getIncidentEvents(session, 'inc-1');
    expect(events[0].operationId).toBeNull();
  });
});

describe('SupabaseRepository.listNotifications: excludes historical update_overdue rows, bounded, category preserved', () => {
  function fakeNotificationsClient(rows: Record<string, unknown>[]) {
    const neqCalls: [string, unknown][] = [];
    const limitCalls: number[] = [];
    const builder = {
      select: () => builder,
      eq: () => builder,
      neq: (col: string, val: unknown) => {
        neqCalls.push([col, val]);
        return builder;
      },
      order: () => builder,
      limit: async (n: number) => {
        limitCalls.push(n);
        return { data: rows, error: null };
      },
    };
    return { client: { from: () => builder }, neqCalls, limitCalls };
  }

  it('filters update_overdue at the query level (never fetched as an active row), and preserves category', async () => {
    const { client, neqCalls } = fakeNotificationsClient([
      {
        id: 'n1',
        user_id: session.userId,
        type: 'incident_assigned',
        category: 'action_required',
        incident_id: 'i1',
        handover_id: null,
        text: 'תקלה הוקצתה אליך',
        read: false,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const repo = new SupabaseRepository(client as unknown as ConstructorParameters<typeof SupabaseRepository>[0]);
    const result = await repo.listNotifications(session);

    expect(neqCalls).toContainEqual(['type', 'update_overdue']);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('incident_assigned');
    expect(result[0].category).toBe('action_required');
  });

  it('bounds the request: never loads unbounded notification history', async () => {
    const { client, limitCalls } = fakeNotificationsClient([]);
    const repo = new SupabaseRepository(client as unknown as ConstructorParameters<typeof SupabaseRepository>[0]);
    await repo.listNotifications(session);

    expect(limitCalls).toEqual([SupabaseRepository.NOTIFICATIONS_LIMIT]);
    expect(SupabaseRepository.NOTIFICATIONS_LIMIT).toBeGreaterThan(0);
  });
});

// Update-specific reporting (migration 0031): getIncidentUpdates must map
// the five new incident_updates columns through to IncidentUpdate exactly,
// including a historical/legacy row where every one of them is null.
describe('SupabaseRepository.getIncidentUpdates: update-specific reporting mapping', () => {
  function repoWithUpdatesQuery(rows: Record<string, unknown>[]): SupabaseRepository {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => Promise.resolve({ data: rows, error: null }),
    };
    const fakeClient = { from: () => builder };
    return new SupabaseRepository(fakeClient as unknown as ConstructorParameters<typeof SupabaseRepository>[0]);
  }

  const baseRow = {
    id: 'upd-1',
    incident_id: 'inc-1',
    author_id: 'u1',
    event_time: '2026-01-01T00:00:00Z',
    server_time: '2026-01-01T00:00:00Z',
    actions_taken: 'נבדק',
    findings: '',
    next_steps: '',
    current_status_text: null,
    created_at: '2026-01-01T00:00:00Z',
  };

  it('maps all three reporting answers when fully answered', async () => {
    const repo = repoWithUpdatesQuery([{
      ...baseRow,
      update_reported_to_ops: 'yes',
      update_reported_to_ops_recipient: 'יוסי מהמוקד',
      update_reported_to_comms: true,
      update_reported_to_comms_recipient: 'דנה מהתקשוב',
      update_wisdom_reported: true,
    }]);
    const updates = await repo.getIncidentUpdates(session, 'inc-1');
    expect(updates[0].updateReportedToOps).toBe('yes');
    expect(updates[0].updateReportedToOpsRecipient).toBe('יוסי מהמוקד');
    expect(updates[0].updateReportedToComms).toBe(true);
    expect(updates[0].updateReportedToCommsRecipient).toBe('דנה מהתקשוב');
    expect(updates[0].updateWisdomReported).toBe(true);
  });

  it('maps a historical row (all five columns null) through without error', async () => {
    const repo = repoWithUpdatesQuery([{
      ...baseRow,
      update_reported_to_ops: null,
      update_reported_to_ops_recipient: null,
      update_reported_to_comms: null,
      update_reported_to_comms_recipient: null,
      update_wisdom_reported: null,
    }]);
    const updates = await repo.getIncidentUpdates(session, 'inc-1');
    expect(updates[0].updateReportedToOps).toBeNull();
    expect(updates[0].updateReportedToOpsRecipient).toBeNull();
    expect(updates[0].updateReportedToComms).toBeNull();
    expect(updates[0].updateReportedToCommsRecipient).toBeNull();
    expect(updates[0].updateWisdomReported).toBeNull();
  });
});
