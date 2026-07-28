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
});
