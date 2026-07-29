// createIncidentSchema: 400-character limits on תיאור התקלה (description)
// and השפעה מבצעית (operational_impact) -- creation-only, mirroring
// migration 0022's own RPC-level validation exactly (same boundary, same
// Hebrew message format). update/close schemas keep their own, unrelated
// limits and are asserted here as an explicit control.
import { describe, expect, it } from 'vitest';
import { createIncidentSchema, updateIncidentSchema, technicianUpdateSchema, type CreateIncidentInput } from './schemas';

function baseInput(overrides: Partial<CreateIncidentInput> = {}) {
  return {
    systemId: 'sys-alpha',
    locationId: 'loc-1',
    discoveredAt: new Date().toISOString(),
    description: 'תקלה לצורך בדיקה',
    severity: 'medium' as const,
    operationalImpact: 'השפעה לצורך בדיקה',
    actionsTaken: 'נבדק',
    status: 'new' as const,
    ownerUserId: 'u-tech-1',
    ownerExternalName: null,
    nextUpdateDue: new Date(Date.now() + 4 * 3600_000).toISOString(),
    noDeadlineReason: null,
    reportedToOps: 'no' as const,
    reportedToComms: false,
    reportedToCommsRecipient: null,
    wisdomReported: false,
    wisdomIncidentNumber: null,
    ...overrides,
  };
}

describe('createIncidentSchema: 400-character limits', () => {
  it('accepts description/operationalImpact at exactly 400 characters (the boundary)', () => {
    const result = createIncidentSchema.safeParse(
      baseInput({ description: 'א'.repeat(400), operationalImpact: 'ב'.repeat(400) }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects description at 401 characters with the exact Hebrew message', () => {
    const result = createIncidentSchema.safeParse(baseInput({ description: 'א'.repeat(401) }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'description' && i.message === 'תיאור התקלה: עד 400 תווים')).toBe(true);
    }
  });

  it('rejects operationalImpact at 401 characters with the exact Hebrew message', () => {
    const result = createIncidentSchema.safeParse(baseInput({ operationalImpact: 'ב'.repeat(401) }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === 'operationalImpact' && i.message === 'השפעה מבצעית: עד 400 תווים'),
      ).toBe(true);
    }
  });

  it('CONTROL: updateIncidentSchema keeps its own unrelated, unchanged 1000-character operationalImpact limit', () => {
    const tooLongForCreate = 'ג'.repeat(600); // over create's 400, under update's own 1000
    const result = updateIncidentSchema.safeParse({
      expectedVersion: 1,
      eventTime: new Date().toISOString(),
      actionsTaken: 'נבדק',
      findings: '',
      nextSteps: '',
      status: 'in_progress',
      severity: 'medium',
      operationalImpact: tooLongForCreate,
      changeReason: '',
      nextUpdateDue: new Date(Date.now() + 3600_000).toISOString(),
      noDeadlineReason: null,
      ownerUserId: 'u-tech-1',
      ownerExternalName: null,
      reportedToOps: 'no',
    });
    expect(result.success).toBe(true);
  });
});

describe('createIncidentSchema: 600-character limit on פעולות שבוצעו עד כה', () => {
  it('accepts actionsTaken at exactly 600 characters (the boundary)', () => {
    const result = createIncidentSchema.safeParse(baseInput({ actionsTaken: 'א'.repeat(600) }));
    expect(result.success).toBe(true);
  });

  it('rejects actionsTaken at 601 characters with the exact Hebrew message', () => {
    const result = createIncidentSchema.safeParse(baseInput({ actionsTaken: 'א'.repeat(601) }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === 'actionsTaken' && i.message === 'פעולות שבוצעו עד כה: עד 600 תווים'),
      ).toBe(true);
    }
  });

  it('CONTROL: updateIncidentSchema and technicianUpdateSchema keep their own unrelated, unchanged 4000-character actionsTaken limit', () => {
    const tooLongForCreate = 'ד'.repeat(1000); // over create's 600, under update's own 4000
    const updateResult = updateIncidentSchema.safeParse({
      expectedVersion: 1,
      eventTime: new Date().toISOString(),
      actionsTaken: tooLongForCreate,
      findings: '',
      nextSteps: '',
      status: 'in_progress',
      severity: 'medium',
      operationalImpact: 'השפעה',
      changeReason: '',
      nextUpdateDue: new Date(Date.now() + 3600_000).toISOString(),
      noDeadlineReason: null,
      ownerUserId: 'u-tech-1',
      ownerExternalName: null,
      reportedToOps: 'no',
    });
    expect(updateResult.success).toBe(true);

    const technicianResult = technicianUpdateSchema.safeParse({
      expectedVersion: 1,
      eventTime: new Date().toISOString(),
      actionsTaken: tooLongForCreate,
      findings: '',
      nextSteps: '',
    });
    expect(technicianResult.success).toBe(true);
  });
});
