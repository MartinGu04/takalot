// createIncidentSchema: 400-character limits on תיאור התקלה (description)
// and השפעה מבצעית (operational_impact) -- creation-only, mirroring
// migration 0022's own RPC-level validation exactly (same boundary, same
// Hebrew message format). update/close schemas keep their own, unrelated
// limits and are asserted here as an explicit control.
import { describe, expect, it } from 'vitest';
import {
  createIncidentSchema,
  updateIncidentSchema,
  technicianUpdateSchema,
  reopenIncidentSchema,
  type CreateIncidentInput,
} from './schemas';

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
    reportedToOps: 'no' as const,
    reportedToComms: false,
    reportedToCommsRecipient: null,
    wisdomReported: false,
    wisdomIncidentNumber: null,
    ...overrides,
  };
}

function baseUpdateInput(overrides: Record<string, unknown> = {}) {
  return {
    expectedVersion: 1,
    eventTime: new Date().toISOString(),
    actionsTaken: 'נבדק',
    findings: '',
    nextSteps: '',
    currentStatusText: 'המצב הנוכחי לצורך בדיקה',
    status: 'in_progress',
    severity: 'medium',
    changeReason: '',
    ownerUserId: 'u-tech-1',
    ownerExternalName: null,
    reportedToOps: 'no',
    ...overrides,
  };
}

describe('createIncidentSchema / updateIncidentSchema: the next-update-ETA concept was removed', () => {
  it('createIncidentSchema no longer has nextUpdateDue/noDeadlineReason keys -- a payload without them is valid', () => {
    const result = createIncidentSchema.safeParse(baseInput());
    expect(result.success).toBe(true);
  });

  it('updateIncidentSchema no longer has nextUpdateDue/noDeadlineReason keys -- a payload without them is valid', () => {
    const result = updateIncidentSchema.safeParse(baseUpdateInput());
    expect(result.success).toBe(true);
  });

  it('reopenIncidentSchema no longer requires nextUpdateDue', () => {
    const result = reopenIncidentSchema.safeParse({
      expectedVersion: 1,
      reason: 'נפתחה מחדש לצורך בדיקה',
      ownerUserId: 'u-tech-1',
      ownerExternalName: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('updateIncidentSchema / technicianUpdateSchema: currentStatusText ("סטטוס נוכחי") is required', () => {
  it('updateIncidentSchema rejects a missing currentStatusText', () => {
    const { currentStatusText: _drop, ...rest } = baseUpdateInput();
    const result = updateIncidentSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'currentStatusText')).toBe(true);
    }
  });

  it('updateIncidentSchema rejects a blank/whitespace-only currentStatusText', () => {
    const result = updateIncidentSchema.safeParse(baseUpdateInput({ currentStatusText: '   ' }));
    expect(result.success).toBe(false);
  });

  it('updateIncidentSchema accepts a real currentStatusText', () => {
    const result = updateIncidentSchema.safeParse(baseUpdateInput({ currentStatusText: 'ממתינים לרכיב חלופי' }));
    expect(result.success).toBe(true);
  });

  it('technicianUpdateSchema rejects a missing currentStatusText', () => {
    const result = technicianUpdateSchema.safeParse({
      expectedVersion: 1,
      eventTime: new Date().toISOString(),
      actionsTaken: 'נבדק',
      findings: '',
      nextSteps: '',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'currentStatusText')).toBe(true);
    }
  });

  it('technicianUpdateSchema accepts a real currentStatusText', () => {
    const result = technicianUpdateSchema.safeParse({
      expectedVersion: 1,
      eventTime: new Date().toISOString(),
      actionsTaken: 'נבדק',
      findings: '',
      nextSteps: '',
      currentStatusText: 'הצוות באתר',
    });
    expect(result.success).toBe(true);
  });
});

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

  it('CONTROL: updateIncidentSchema has its own unrelated 1000-character currentStatusText limit, not create\'s 400', () => {
    const overCreatesLimit = 'ג'.repeat(600); // over create's operationalImpact 400, under update's currentStatusText 1000
    const result = updateIncidentSchema.safeParse(baseUpdateInput({ currentStatusText: overCreatesLimit }));
    expect(result.success).toBe(true);
  });

  it('updateIncidentSchema rejects currentStatusText at 1001 characters', () => {
    const result = updateIncidentSchema.safeParse(baseUpdateInput({ currentStatusText: 'ג'.repeat(1001) }));
    expect(result.success).toBe(false);
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
    const updateResult = updateIncidentSchema.safeParse(baseUpdateInput({ actionsTaken: tooLongForCreate }));
    expect(updateResult.success).toBe(true);

    const technicianResult = technicianUpdateSchema.safeParse({
      expectedVersion: 1,
      eventTime: new Date().toISOString(),
      actionsTaken: tooLongForCreate,
      findings: '',
      nextSteps: '',
      currentStatusText: 'המצב הנוכחי לצורך בדיקה',
    });
    expect(technicianResult.success).toBe(true);
  });
});
