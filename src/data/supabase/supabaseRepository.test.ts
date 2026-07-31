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
      repoWithRpcError('conflict: כבר קיימת מערכת / עמדה בשם זה').createSystem(session, 'שם'),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'כבר קיימת מערכת / עמדה בשם זה',
    });
  });

  it('keeps permission, validation, conflict, and not-found mapping on reference-data RPCs', async () => {
    await expect(
      repoWithRpcError('permission: אין הרשאה לנהל מערכות ומיקומים').createLocation(session, 'שם'),
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
  });

  it('sanitizes unexpected PostgreSQL details only on reference-data RPCs', async () => {
    const raw = 'duplicate key value violates unique constraint systems_name_normalized_unique (SQLSTATE 23505)';
    try {
      await repoWithRpcError(raw).createSystem(session, 'שם');
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

    await expect(repo.createSystem(session, ' מערכת ')).resolves.toMatchObject({
      id: 'system-1',
      displayOrder: 7,
    });
    await repo.renameSystem(session, 'system-1', 'שם חדש');
    await repo.setSystemArchived(session, 'system-1', true);
    await repo.moveSystem(session, 'system-1', 'down');
    await expect(repo.deleteSystem(session, 'system-1')).resolves.toBe('deleted');

    expect(calls).toEqual([
      { fn: 'create_system', args: { p_name: ' מערכת ' } },
      { fn: 'rename_system', args: { p_system_id: 'system-1', p_name: 'שם חדש' } },
      { fn: 'set_system_active', args: { p_system_id: 'system-1', p_active: false } },
      { fn: 'move_system', args: { p_system_id: 'system-1', p_direction: 'down' } },
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

    await repo.createLocation(session, 'מיקום');
    await repo.renameLocation(session, 'location-1', 'מיקום חדש');
    await repo.setLocationArchived(session, 'location-1', false);
    await repo.moveLocation(session, 'location-1', 'up');
    await expect(repo.deleteLocation(session, 'location-1')).resolves.toBe('archived');

    expect(calls).toEqual([
      'create_location',
      'rename_location',
      'set_location_active',
      'move_location',
      'delete_location',
    ]);
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

describe('SupabaseRepository.listNotifications: excludes historical update_overdue rows', () => {
  function fakeNotificationsClient(rows: Record<string, unknown>[]) {
    const neqCalls: [string, unknown][] = [];
    const builder = {
      select: () => builder,
      eq: () => builder,
      neq: (col: string, val: unknown) => {
        neqCalls.push([col, val]);
        return builder;
      },
      order: async () => ({ data: rows, error: null }),
    };
    return { client: { from: () => builder }, neqCalls };
  }

  it('filters update_overdue at the query level (never fetched as an active row)', async () => {
    const { client, neqCalls } = fakeNotificationsClient([
      {
        id: 'n1',
        user_id: session.userId,
        type: 'incident_assigned',
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
  });
});
