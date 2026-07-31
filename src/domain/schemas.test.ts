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
  assignIncidentSchema,
  closeIncidentSchema,
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
    updateReportedToOps: 'not_required',
    updateReportedToOpsRecipient: null,
    updateReportedToComms: 'no',
    updateReportedToCommsRecipient: null,
    updateWisdomReported: 'no',
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

// Update-specific reporting (migration 0031): three fresh per-update
// questions, deliberately distinct payload keys from the incident-level
// reportedToOps/reportedToOpsRecipient (createIncidentSchema/
// closeIncidentSchema still use those unchanged). Each one starts as ''
// (not yet answered) in UpdateDialog and the schema must reject that
// unanswered state explicitly, not silently accept it.
describe('updateIncidentSchema: update-specific reporting requires an explicit answer', () => {
  it('accepts a fully-answered payload (the base fixture)', () => {
    expect(updateIncidentSchema.safeParse(baseUpdateInput()).success).toBe(true);
  });

  it('rejects an unanswered updateReportedToOps', () => {
    const result = updateIncidentSchema.safeParse(baseUpdateInput({ updateReportedToOps: '' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'updateReportedToOps')).toBe(true);
    }
  });

  it('rejects an unanswered updateReportedToComms', () => {
    const result = updateIncidentSchema.safeParse(baseUpdateInput({ updateReportedToComms: '' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'updateReportedToComms')).toBe(true);
    }
  });

  it('rejects an unanswered updateWisdomReported', () => {
    const result = updateIncidentSchema.safeParse(baseUpdateInput({ updateWisdomReported: '' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'updateWisdomReported')).toBe(true);
    }
  });

  it('preserves yes/no/not_required for updateReportedToOps, and requires a recipient only when "yes"', () => {
    expect(updateIncidentSchema.safeParse(baseUpdateInput({ updateReportedToOps: 'not_required' })).success).toBe(true);
    expect(updateIncidentSchema.safeParse(baseUpdateInput({ updateReportedToOps: 'no' })).success).toBe(true);
    const missingRecipient = updateIncidentSchema.safeParse(
      baseUpdateInput({ updateReportedToOps: 'yes', updateReportedToOpsRecipient: '' }),
    );
    expect(missingRecipient.success).toBe(false);
    const withRecipient = updateIncidentSchema.safeParse(
      baseUpdateInput({ updateReportedToOps: 'yes', updateReportedToOpsRecipient: 'אחמ״ש מוקד מבצעים' }),
    );
    expect(withRecipient.success).toBe(true);
  });

  it('requires a recipient only when updateReportedToComms is "yes"', () => {
    const missingRecipient = updateIncidentSchema.safeParse(
      baseUpdateInput({ updateReportedToComms: 'yes', updateReportedToCommsRecipient: '' }),
    );
    expect(missingRecipient.success).toBe(false);
    const withRecipient = updateIncidentSchema.safeParse(
      baseUpdateInput({ updateReportedToComms: 'yes', updateReportedToCommsRecipient: 'תקשוב מוקד מבצעים' }),
    );
    expect(withRecipient.success).toBe(true);
  });

  it('updateWisdomReported has no dependent recipient/number field -- "yes" alone is sufficient', () => {
    const result = updateIncidentSchema.safeParse(baseUpdateInput({ updateWisdomReported: 'yes' }));
    expect(result.success).toBe(true);
  });

  it('a legacy reportedToOps/reportedToOpsRecipient payload key is not read as update-specific reporting -- it is silently stripped, not an error, and does not satisfy the new required questions on its own', () => {
    const legacyOnly = updateIncidentSchema.safeParse({
      ...baseUpdateInput({ updateReportedToOps: '' }),
      reportedToOps: 'yes',
      reportedToOpsRecipient: 'ערך מלקוח ישן',
    });
    // The legacy keys don't rescue the still-unanswered new question.
    expect(legacyOnly.success).toBe(false);

    const fullyAnswered = updateIncidentSchema.safeParse({
      ...baseUpdateInput(),
      reportedToOps: 'yes',
      reportedToOpsRecipient: 'ערך מלקוח ישן',
    });
    expect(fullyAnswered.success).toBe(true);
    if (fullyAnswered.success) {
      // Unknown keys are stripped by zod's default object parsing -- they
      // never reach the parsed output at all.
      expect((fullyAnswered.data as Record<string, unknown>).reportedToOps).toBeUndefined();
    }
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

// Additive external handling party (migration 0032): a separate, always-
// optional org/handler alongside the (now uniformly mandatory) internal
// owner. update/assign/close/reopen no longer accept "internal OR external"
// -- an internal owner is required outright, exactly like create_incident
// already required since 0019.
describe('external handling party: internal owner is now mandatory on every lifecycle schema', () => {
  it('createIncidentSchema: unchanged -- still requires an internal owner and rejects an external-only one', () => {
    const missing = createIncidentSchema.safeParse(baseInput({ ownerUserId: null }));
    expect(missing.success).toBe(false);
    const externalOnly = createIncidentSchema.safeParse(baseInput({ ownerUserId: null, ownerExternalName: 'ספק חיצוני' }));
    expect(externalOnly.success).toBe(false);
  });

  it('updateIncidentSchema rejects a null internal owner (the UI\'s own "not selected" value)', () => {
    const result = updateIncidentSchema.safeParse(baseUpdateInput({ ownerUserId: null }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'ownerUserId' && i.message === 'יש לבחור בעל אחריות פנימי')).toBe(true);
    }
  });

  it('updateIncidentSchema no longer has an ownerExternalName key -- it is stripped, not read', () => {
    const parsed = updateIncidentSchema.safeParse({ ...baseUpdateInput(), ownerExternalName: 'לא אמור להישמר' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>).ownerExternalName).toBeUndefined();
    }
  });

  it('assignIncidentSchema rejects a null internal owner', () => {
    const result = assignIncidentSchema.safeParse({ expectedVersion: 1, note: '', ownerUserId: null });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'ownerUserId' && i.message === 'יש לבחור בעל אחריות פנימי')).toBe(true);
    }
  });

  it('assignIncidentSchema accepts a valid internal owner with no external-handler fields at all', () => {
    const result = assignIncidentSchema.safeParse({ expectedVersion: 1, note: '', ownerUserId: 'u-tech-1' });
    expect(result.success).toBe(true);
  });

  it('reopenIncidentSchema rejects a null internal owner', () => {
    const result = reopenIncidentSchema.safeParse({ expectedVersion: 1, reason: 'סיבה', ownerUserId: null });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'ownerUserId' && i.message === 'יש לבחור בעל אחריות פנימי')).toBe(true);
    }
  });

  it('closeIncidentSchema: internal owner is required only when readiness is not full', () => {
    const fullReadyNoOwner = closeIncidentSchema.safeParse({
      expectedVersion: 1,
      rootCause: 'סיבה',
      resolution: 'פתרון',
      readiness: 'full',
      reportedToOps: 'not_required',
    });
    expect(fullReadyNoOwner.success).toBe(true);

    const partialNoOwner = closeIncidentSchema.safeParse({
      expectedVersion: 1,
      rootCause: 'סיבה',
      resolution: 'פתרון',
      readiness: 'partial',
      followUpNotes: 'המשך טיפול',
      reportedToOps: 'not_required',
    });
    expect(partialNoOwner.success).toBe(false);
    if (!partialNoOwner.success) {
      expect(partialNoOwner.error.issues.some((i) => i.path[0] === 'ownerUserId')).toBe(true);
    }

    const partialWithOwner = closeIncidentSchema.safeParse({
      expectedVersion: 1,
      rootCause: 'סיבה',
      resolution: 'פתרון',
      readiness: 'partial',
      followUpNotes: 'המשך טיפול',
      ownerUserId: 'u-tech-1',
      reportedToOps: 'not_required',
    });
    expect(partialWithOwner.success).toBe(true);
  });
});

describe('external handling party: name-required-with-contact validation', () => {
  it('createIncidentSchema rejects a contact person with no external-handler name', () => {
    const result = createIncidentSchema.safeParse(baseInput({ externalHandlerContactPerson: 'דנה' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) => i.path[0] === 'externalHandlerName' && i.message === 'יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר',
        ),
      ).toBe(true);
    }
  });

  it('createIncidentSchema rejects contact details with no external-handler name', () => {
    const result = createIncidentSchema.safeParse(baseInput({ externalHandlerContactDetails: '03-1234567' }));
    expect(result.success).toBe(false);
  });

  it('createIncidentSchema accepts a name alone, with no contact info at all', () => {
    const result = createIncidentSchema.safeParse(baseInput({ externalHandlerName: 'ארגון שותף' }));
    expect(result.success).toBe(true);
  });

  it('createIncidentSchema accepts the full external-handler trio together', () => {
    const result = createIncidentSchema.safeParse(
      baseInput({
        externalHandlerName: 'ארגון שותף',
        externalHandlerContactPerson: 'דנה',
        externalHandlerContactDetails: '03-1234567',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('createIncidentSchema treats a whitespace-only name as absent when contact info is supplied (blank-as-absent)', () => {
    const result = createIncidentSchema.safeParse(
      baseInput({ externalHandlerName: '   ', externalHandlerContactPerson: 'דנה' }),
    );
    expect(result.success).toBe(false);
  });

  it('createIncidentSchema accepts no external handler at all', () => {
    const result = createIncidentSchema.safeParse(baseInput());
    expect(result.success).toBe(true);
  });

  it('updateIncidentSchema: an EXPLICITLY blank name alongside contact info is rejected', () => {
    const result = updateIncidentSchema.safeParse(
      baseUpdateInput({ externalHandlerName: '', externalHandlerContactPerson: 'דנה' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'externalHandlerName')).toBe(true);
    }
  });

  it('updateIncidentSchema: OMITTING the name key while supplying contact is accepted client-side -- omission means "preserve," and this schema has no visibility into the incident\'s existing name; the repository/RPC layer (which merges with the existing value) is the actual enforcement point for this combination', () => {
    const result = updateIncidentSchema.safeParse(baseUpdateInput({ externalHandlerContactPerson: 'דנה' }));
    expect(result.success).toBe(true);
  });

  it('closeIncidentSchema applies the name-required-with-contact rule unconditionally, even at full readiness, when the name is explicitly blank', () => {
    const result = closeIncidentSchema.safeParse({
      expectedVersion: 1,
      rootCause: 'סיבה',
      resolution: 'פתרון',
      readiness: 'full',
      reportedToOps: 'not_required',
      externalHandlerName: '',
      externalHandlerContactPerson: 'דנה',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'externalHandlerName')).toBe(true);
    }
  });
});
