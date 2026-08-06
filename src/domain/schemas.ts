// Zod schemas shared by forms (client) and the data layer (server-side style validation).
import { z } from 'zod';

/** Reject empty or whitespace-only values. */
const nonBlank = (max: number, label: string) =>
  z
    .string()
    .max(max, `${label}: עד ${max} תווים`)
    .refine((v) => v.trim().length > 0, `${label}: שדה חובה`);

const optionalText = (max: number, label: string) =>
  z.string().max(max, `${label}: עד ${max} תווים`).optional().default('');

export const severitySchema = z.enum(['critical', 'high', 'medium', 'low']);
export const statusSchema = z.enum([
  'new',
  'acknowledged',
  'in_progress',
  'waiting_external',
  'waiting_test',
  'monitoring',
  'partial_readiness',
  'resolved_pending_close',
  'closed',
  'reopened',
  'cancelled',
  'waiting_equipment',
  'waiting_information',
  'waiting_validation',
]);
export const reportedToOpsSchema = z.enum(['yes', 'no', 'not_required']);
export const readinessSchema = z.enum(['full', 'partial', 'none']);

// ===== Structured incident lifecycle classification =====
// Mirrors the six Postgres enums added in migration 0045 exactly (stable
// English values; Hebrew labels live only in src/domain/labels.ts).
export const incidentDomainSchema = z.enum([
  'communications',
  'equipment',
  'software',
  'infrastructure',
  'operational',
  'unknown',
  'other',
]);
export const suspectedCauseSchema = z.enum([
  'equipment',
  'software',
  'communications',
  'infrastructure',
  'operational',
  'external',
  'unknown',
  'other',
]);
export const treatmentActionTypeSchema = z.enum([
  'diagnosis',
  'reset_restart',
  'equipment_replacement',
  'config_change',
  'software_fix',
  'communications_handling',
  'infrastructure_handling',
  'external_party_handling',
  'other',
]);
export const confirmedCauseSchema = z.enum([
  'equipment',
  'software',
  'communications',
  'infrastructure',
  'operational',
  'external',
  'undetermined',
  'other',
]);
export const treatmentOutcomeSchema = z.enum([
  'permanent_resolution',
  'temporary_workaround',
  'not_reproduced',
  'resolved_without_action',
  'closed_without_technical_resolution',
  'other',
]);
export const resolutionAttributionSchema = z.enum([
  'specific_action',
  'combination_of_actions',
  'undetermined',
  'no_action_taken',
  'external_party_no_details',
  'other',
]);

/** One structured treatment-action entry -- shared by creation's optional
 *  initial actions, an update's treatmentActions, and closure's
 *  newTreatmentActions. 'other' requires a short explanation, mirroring
 *  every RPC that accepts this shape. */
export const treatmentActionInputSchema = z
  .object({
    actionType: treatmentActionTypeSchema,
    otherDetail: z.string().max(500, 'פירוט הפעולה: עד 500 תווים').nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.actionType === 'other' && !(data.otherDetail ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['otherDetail'],
        message: 'יש לפרט את הפעולה',
      });
    }
  });

export type TreatmentActionInput = z.infer<typeof treatmentActionInputSchema>;

/** Number of DISTINCT (actionType, otherDetail) entries in a treatment-
 *  action array -- mirrors the RPC's own within-one-array de-duplication
 *  exactly (see create_incident_impl/update_incident/close_incident_impl,
 *  migration 0047), so client-side "how many actions is this" counts
 *  (e.g. combination_of_actions' at-least-two-distinct rule) never
 *  disagree with what the server will actually persist. */
function distinctActionCount(actions: TreatmentActionInput[]): number {
  const keys = new Set(actions.map((a) => `${a.actionType}|${(a.otherDetail ?? '').trim()}`));
  return keys.size;
}

/** Exact allowlist of statuses create_incident may open with, mirroring the
 *  backend's own allowlist (migration 0017) exactly -- not a growing
 *  blocklist. Excludes closed/reopened (dedicated flows) and cancelled/
 *  waiting_equipment/waiting_information/waiting_validation (either
 *  dedicated-flow-only or not yet reachable via any RPC). */
const CREATABLE_STATUSES = new Set([
  'new',
  'acknowledged',
  'in_progress',
  'waiting_external',
  'waiting_test',
  'monitoring',
  'partial_readiness',
  'resolved_pending_close',
]);

const ownerFields = {
  ownerUserId: z.string().nullable(),
  ownerExternalName: z.string().max(120, 'שם גורם חיצוני: עד 120 תווים').nullable(),
};

/** Internal owner only -- used by every flow where the (now always
 *  mandatory) internal owner is unconditionally required. The legacy
 *  ownerExternalName key is deliberately absent: these flows never send it,
 *  and the backend tolerates but ignores it if an old client still does. */
const internalOwnerField = {
  ownerUserId: z.string().nullable(),
};

/** Internal owner only, optionally required (used by close_incident, where
 *  an owner is required only when readiness is not full). */
const optionalInternalOwnerField = {
  ownerUserId: z.string().nullable().optional(),
};

/** The additive external handling party -- always optional, independent of
 *  the internal owner. Shared by every lifecycle flow: creation, update,
 *  assignment, closure at every readiness level, and reopening. */
const externalHandlerFields = {
  externalHandlerName: z.string().max(120, 'שם גורם מטפל חיצוני: עד 120 תווים').nullable().optional(),
  externalHandlerContactPerson: z.string().max(120, 'איש קשר: עד 120 תווים').nullable().optional(),
  externalHandlerContactDetails: z.string().max(500, 'פרטי קשר: עד 500 תווים').nullable().optional(),
};

/** Contact person/details are only meaningful once a name is given -- one
 *  directional, mirroring migration 0032's RPC-level guard and CHECK
 *  constraint exactly (blank-as-absent). Used by createIncidentSchema,
 *  where there is no prior incident to merge with: an omitted name is the
 *  same as a blank one. */
function checkExternalHandlerNameRequired(
  data: {
    externalHandlerName?: string | null;
    externalHandlerContactPerson?: string | null;
    externalHandlerContactDetails?: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  const hasContact =
    (data.externalHandlerContactPerson ?? '').trim() || (data.externalHandlerContactDetails ?? '').trim();
  if (hasContact && !(data.externalHandlerName ?? '').trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['externalHandlerName'],
      message: 'יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר',
    });
  }
}

/** Same rule, but for update_incident/assign_incident/close_incident/
 *  reopen_incident, which merge an OMITTED key with the incident's existing
 *  value (preserve-on-omit) before this check would ever run server-side --
 *  this schema has no visibility into that existing value, so an omitted
 *  name must NOT be treated as blank here (that would wrongly reject a
 *  contact-only update against an incident that already has a name). Only
 *  an EXPLICITLY supplied blank/null name, alongside contact info, is
 *  caught client-side; a bad omitted-name-with-new-contact combination is
 *  still caught by the repository/RPC layer, which has the merged value. */
function checkExternalHandlerNameRequiredOnSupply(
  data: {
    externalHandlerName?: string | null;
    externalHandlerContactPerson?: string | null;
    externalHandlerContactDetails?: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (data.externalHandlerName === undefined) return;
  checkExternalHandlerNameRequired(data, ctx);
}

const reportedToOpsFields = {
  reportedToOps: reportedToOpsSchema,
  reportedToOpsRecipient: z.string().max(200, 'למי דווח: עד 200 תווים').nullable().optional(),
};

/** Required only when reportedToOps is 'yes'; must be cleared/ignored otherwise. */
function checkReportedToOpsRecipient(
  data: { reportedToOps: string; reportedToOpsRecipient?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (data.reportedToOps === 'yes' && !(data.reportedToOpsRecipient ?? '').trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reportedToOpsRecipient'],
      message: 'יש להזין למי דווח',
    });
  }
}

export const createIncidentSchema = z
  .object({
    systemId: z.string().min(1, 'יש לבחור מערכת / עמדה'),
    locationId: z.string().min(1, 'יש לבחור מיקום'),
    discoveredAt: z.string().min(1, 'יש להזין שעת גילוי'),
    // Creation-only limits: tighter than update/close's own operationalImpact
    // (1000) -- description doesn't exist at all past creation, and this
    // 400-character cap only applies to opening an incident, not revising it
    // later.
    description: nonBlank(400, 'תיאור התקלה'),
    severity: severitySchema,
    operationalImpact: nonBlank(400, 'השפעה מבצעית'),
    // 600 characters, creation only -- update/technician-update's own
    // actionsTaken (a running log entry per update, not the one-time
    // opening note) keeps its unrelated, unchanged 4000-character limit.
    actionsTaken: nonBlank(600, 'פעולות שבוצעו עד כה'),
    status: statusSchema.refine((s) => CREATABLE_STATUSES.has(s), {
      message: 'סטטוס פתיחה חייב להיות סטטוס פעיל נתמך',
    }),
    ...ownerFields,
    ...externalHandlerFields,
    ...reportedToOpsFields,
    // Opening-time-only questions -- both plain booleans (unlike
    // reportedToOps, there is no third "not_required" state here), each with
    // a dependent field that is required exactly when its question is true
    // and must otherwise be absent (enforced below and, authoritatively, by
    // migration 0021's own bidirectional CHECK constraints).
    reportedToComms: z.boolean(),
    reportedToCommsRecipient: z.string().max(200, 'למי דווח: עד 200 תווים').nullable(),
    wisdomReported: z.boolean(),
    wisdomIncidentNumber: z.string().max(100, 'מספר תקלה ב-WISDOM: עד 100 תווים').nullable(),
    /** Optional free-text "הערה נוספת" -- never overwrites actionsTaken or
     *  any other generated/required field; stored on its own dedicated
     *  column, see migration 0038. */
    note: optionalText(600, 'הערה נוספת'),
    /** תחום התקלה -- the one new required field the product spec permits
     *  at creation. Required here in the client regardless of which RPC
     *  ultimately enforces it server-side (create_incident_v2 always
     *  does; the legacy create_incident stays permissive for any still-
     *  cached old client -- see migration 0047). */
    reportedDomain: incidentDomainSchema,
    /** Optional, behind the "הוספת חשד ראשוני ופרטי טיפול" disclosure --
     *  becomes the incident's first current assessment when supplied.
     *  Omitted entirely (not merely nullable) when the disclosure is left
     *  untouched, so create_incident/create_incident_v2 never receive the
     *  key at all in that case. */
    initialSuspectedCause: suspectedCauseSchema.optional(),
    initialSuspectedCauseOtherDetail: z.string().max(500, 'פירוט החשד הראשוני: עד 500 תווים').nullable().optional(),
    /** Optional structured actions already performed before the incident
     *  was opened -- supplements, never replaces, actionsTaken above. */
    initialTreatmentActions: z.array(treatmentActionInputSchema).max(10, 'ניתן להוסיף עד 10 פעולות').optional().default([]),
  })
  .superRefine((data, ctx) => {
    if (data.initialSuspectedCause === 'other' && !(data.initialSuspectedCauseOtherDetail ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['initialSuspectedCauseOtherDetail'],
        message: 'יש לפרט את החשד הראשוני',
      });
    }
    // Unlike every other flow that shares ownerFields (update/close/assign/
    // reopen, which all accept an internal OR a named external handler),
    // opening a NEW incident requires an internal בעל אחריות פנימי
    // specifically -- the person accountable for the incident not falling
    // between the cracks, not necessarily who performs the technical work.
    // This mirrors create_incident's own database-level enforcement
    // (migration 0019, on top of the shared assert_owner_valid helper,
    // which stays nullable for the other flows) -- both checks, in the
    // same order, so a direct repository/RPC caller can never reach a state
    // this form itself would have blocked: owner missing first, then
    // (only once an owner IS present) external name rejected outright,
    // never silently dropped.
    if (!data.ownerUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerUserId'],
        message: 'יש לבחור בעל אחריות פנימי',
      });
    } else if ((data.ownerExternalName ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerUserId'],
        message: 'לא ניתן לקבוע גורם חיצוני כבעל אחריות בעת פתיחת תקלה',
      });
    }
    checkReportedToOpsRecipient(data, ctx);
    if (data.reportedToComms && !(data.reportedToCommsRecipient ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reportedToCommsRecipient'],
        message: 'יש להזין למי דווח',
      });
    }
    if (data.wisdomReported && !(data.wisdomIncidentNumber ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['wisdomIncidentNumber'],
        message: 'יש להזין מספר תקלה ב-WISDOM',
      });
    }
    checkExternalHandlerNameRequired(data, ctx);
  });

export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;

export const updateIncidentSchema = z
  .object({
    expectedVersion: z.number(),
    eventTime: z.string().min(1, 'יש להזין שעת עדכון'),
    actionsTaken: nonBlank(4000, 'פעולות שבוצעו'),
    findings: optionalText(4000, 'ממצאים'),
    nextSteps: optionalText(2000, 'פעולות המשך'),
    // מצב הטיפול -- the structured treatment-state selector. Still the
    // full IncidentStatus enum server-side (statusSchema), narrowed only by
    // what the update UI actually offers (UpdateDialog's own target set).
    status: statusSchema,
    severity: severitySchema,
    // סטטוס נוכחי -- the free-text situational description at the moment
    // of this update. Required in the new update UI; replaces the purpose
    // operationalImpact used to serve here (that field is now creation-only,
    // see createIncidentSchema).
    currentStatusText: nonBlank(1000, 'סטטוס נוכחי'),
    changeReason: z.string().max(500).optional().default(''),
    /** Optional free-text "הערה נוספת" on this specific update -- stored on
     *  its own incident_updates column, never mixed with changeReason or any
     *  other field. See migration 0038. */
    note: optionalText(600, 'הערה נוספת'),
    ...internalOwnerField,
    ...externalHandlerFields,
    // Update-specific reporting -- three fresh questions about THIS update
    // only, deliberately distinct payload keys from the incident-level
    // reportedToOps/reportedToOpsRecipient (reportedToOpsFields, above):
    // this update flow no longer reads or mutates those opening-time
    // fields at all (see update_incident, migration 0031). Each answer
    // starts as '' (not yet answered) in the UI and is required -- the
    // union with the empty-string literal is what lets this schema reject
    // an unanswered question with a clear message instead of silently
    // treating "" as a legitimate enum member.
    updateReportedToOps: z.union([reportedToOpsSchema, z.literal('')]),
    updateReportedToOpsRecipient: z.string().max(200, 'למי דווח: עד 200 תווים').nullable().optional(),
    updateReportedToComms: z.union([z.literal('yes'), z.literal('no'), z.literal('')]),
    updateReportedToCommsRecipient: z.string().max(200, 'למי דווח: עד 200 תווים').nullable().optional(),
    updateWisdomReported: z.union([z.literal('yes'), z.literal('no'), z.literal('')]),
    /** Optional, behind the "הוספת פרטי טיפול" disclosure. Genuinely
     *  `.optional()` (not defaulted) -- an omitted key means "untouched,"
     *  never reconfirmed on every update; only an actively chosen value
     *  is sent, and only when it differs from the incident's current one
     *  does the RPC record a change. */
    suspectedCause: suspectedCauseSchema.optional(),
    suspectedCauseOtherDetail: z.string().max(500, 'פירוט החשד: עד 500 תווים').nullable().optional(),
    /** Cumulative structured actions performed in this update --
     *  supplements, never replaces, actionsTaken above. */
    treatmentActions: z.array(treatmentActionInputSchema).max(10, 'ניתן להוסיף עד 10 פעולות').optional().default([]),
  })
  .superRefine((data, ctx) => {
    if (!data.ownerUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerUserId'],
        message: 'יש לבחור בעל אחריות פנימי',
      });
    }
    checkExternalHandlerNameRequiredOnSupply(data, ctx);
    if (data.suspectedCause === 'other' && !(data.suspectedCauseOtherDetail ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['suspectedCauseOtherDetail'],
        message: 'יש לפרט את החשד',
      });
    }
    if (data.updateReportedToOps === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updateReportedToOps'],
        message: 'יש לענות האם דווח למבצעים בעדכון זה',
      });
    } else if (data.updateReportedToOps === 'yes' && !(data.updateReportedToOpsRecipient ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updateReportedToOpsRecipient'],
        message: 'יש להזין למי דווח (מבצעים)',
      });
    }
    if (data.updateReportedToComms === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updateReportedToComms'],
        message: 'יש לענות האם דווח לתקשוב למבצעים בעדכון זה',
      });
    } else if (data.updateReportedToComms === 'yes' && !(data.updateReportedToCommsRecipient ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updateReportedToCommsRecipient'],
        message: 'יש להזין למי דווח (תקשוב למבצעים)',
      });
    }
    if (data.updateWisdomReported === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updateWisdomReported'],
        message: 'יש לענות האם עודכן ב-WISDOM בעדכון זה',
      });
    }
  });

export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>;

/** Technician updates: content only, no protected fields. Optional cause/
 *  action classification IS permitted here -- it's operational technical
 *  detail, not one of the protected owner/status/severity/reporting
 *  fields, and the spec explicitly grants it to "anyone currently allowed
 *  to post the relevant incident update." */
export const technicianUpdateSchema = z
  .object({
    expectedVersion: z.number(),
    eventTime: z.string().min(1, 'יש להזין שעת עדכון'),
    actionsTaken: nonBlank(4000, 'פעולות שבוצעו'),
    findings: optionalText(4000, 'ממצאים'),
    nextSteps: optionalText(2000, 'הצעות להמשך'),
    currentStatusText: nonBlank(1000, 'סטטוס נוכחי'),
    /** Optional free-text "הערה נוספת" -- content-only, exactly like every
     *  other field on this schema; grants no protected-field capability. See
     *  migration 0038. */
    note: optionalText(600, 'הערה נוספת'),
    suspectedCause: suspectedCauseSchema.optional(),
    suspectedCauseOtherDetail: z.string().max(500, 'פירוט החשד: עד 500 תווים').nullable().optional(),
    treatmentActions: z.array(treatmentActionInputSchema).max(10, 'ניתן להוסיף עד 10 פעולות').optional().default([]),
  })
  .superRefine((data, ctx) => {
    if (data.suspectedCause === 'other' && !(data.suspectedCauseOtherDetail ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['suspectedCauseOtherDetail'],
        message: 'יש לפרט את החשד',
      });
    }
  });

export type TechnicianUpdateInput = z.infer<typeof technicianUpdateSchema>;

export const closeIncidentSchema = z
  .object({
    expectedVersion: z.number(),
    eventTime: z.string().min(1, 'יש להזין מועד סגירת התקלה בפועל'),
    rootCause: nonBlank(2000, 'סיבת התקלה'),
    resolution: nonBlank(4000, 'הפתרון שבוצע'),
    readiness: readinessSchema,
    followUpNotes: z.string().max(2000).optional().default(''),
    /** Optional free-text "הערה נוספת" -- never overwrites rootCause/
     *  resolution/followUpNotes; stored on its own dedicated column at
     *  every readiness level. See migration 0038. */
    note: optionalText(600, 'הערה נוספת'),
    ...optionalInternalOwnerField,
    ...externalHandlerFields,
    ...reportedToOpsFields,
    // Structured closure classification -- required in the client
    // regardless of which RPC ultimately enforces it server-side
    // (close_incident_v2 always does on a full-readiness close; the
    // legacy close_incident stays permissive for any still-cached old
    // client -- see migration 0047). Only meaningful/sent when
    // readiness === 'full': CloseDialog shows this whole block only then,
    // mirroring how followUpNotes/ownerUserId above are shown only when
    // readiness !== 'full'.
    // `.optional()`, not required at the base-type level: these three are
    // only ever collected (and only ever sent) when readiness === 'full' --
    // a partial-readiness close never asks for them at all. Required-ness
    // is enforced in the superRefine below, exactly like followUpNotes/
    // ownerUserId's own "required only when readiness !== 'full'" check
    // just above it.
    confirmedCause: confirmedCauseSchema.optional(),
    confirmedCauseOtherDetail: z.string().max(500, 'פירוט הגורם שאומת: עד 500 תווים').nullable().optional(),
    treatmentOutcome: treatmentOutcomeSchema.optional(),
    treatmentOutcomeOtherDetail: z.string().max(500, 'פירוט תוצאת הטיפול: עד 500 תווים').nullable().optional(),
    resolutionAttribution: resolutionAttributionSchema.optional(),
    resolutionAttributionOtherDetail: z.string().max(500, 'פירוט: עד 500 תווים').nullable().optional(),
    /** Previously-recorded IncidentTreatmentAction ids selected for this
     *  closure's resolution attribution. */
    resolutionActionIds: z.array(z.string()).max(20, 'ניתן לבחור עד 20 פעולות').optional().default([]),
    /** New treatment actions recorded inline during closure -- an ARRAY,
     *  since combination_of_actions may need two brand-new actions even
     *  when none were recorded earlier. */
    newTreatmentActions: z.array(treatmentActionInputSchema).max(10, 'ניתן להוסיף עד 10 פעולות').optional().default([]),
  })
  .superRefine((data, ctx) => {
    if (data.readiness !== 'full') {
      if (!data.followUpNotes.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['followUpNotes'],
          message: 'בסגירה עם כשירות חלקית או ללא כשירות יש לפרט פעולות המשך',
        });
      }
      if (!data.ownerUserId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ownerUserId'],
          message: 'כאשר הכשירות אינה מלאה יש לקבוע גורם מטפל אחראי המשך',
        });
      }
    } else {
      if (!data.confirmedCause) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['confirmedCause'],
          message: 'יש לבחור את הגורם שאומת',
        });
      }
      if (!data.treatmentOutcome) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['treatmentOutcome'],
          message: 'יש לבחור את תוצאת הטיפול',
        });
      }
      if (!data.resolutionAttribution) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resolutionAttribution'],
          message: 'יש לבחור מה ידוע על מה שהוביל לפתרון',
        });
      }
      if (data.confirmedCause === 'other' && !(data.confirmedCauseOtherDetail ?? '').trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['confirmedCauseOtherDetail'],
          message: 'יש לפרט את הגורם שאומת',
        });
      }
      if (data.treatmentOutcome === 'other' && !(data.treatmentOutcomeOtherDetail ?? '').trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['treatmentOutcomeOtherDetail'],
          message: 'יש לפרט את תוצאת הטיפול',
        });
      }
      if (data.resolutionAttribution === 'other' && !(data.resolutionAttributionOtherDetail ?? '').trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resolutionAttributionOtherDetail'],
          message: 'יש לפרט מה ידוע על מה שהוביל לפתרון',
        });
      }
      if (data.treatmentOutcome === 'resolved_without_action' && data.resolutionAttribution !== 'no_action_taken') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resolutionAttribution'],
          message: "כאשר התקלה נעלמה ללא פעולה, מה שהוביל לפתרון חייב להיות 'לא בוצעה פעולה'",
        });
      }
      const linkedCount = data.resolutionActionIds.length + distinctActionCount(data.newTreatmentActions);
      if (data.resolutionAttribution === 'specific_action' && linkedCount !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resolutionActionIds'],
          message: 'יש לבחור פעולה מסוימת אחת בדיוק',
        });
      }
      if (data.resolutionAttribution === 'combination_of_actions' && linkedCount < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resolutionActionIds'],
          message: 'יש לבחור לפחות שתי פעולות שונות',
        });
      }
      if (
        (data.resolutionAttribution === 'undetermined' ||
          data.resolutionAttribution === 'no_action_taken' ||
          data.resolutionAttribution === 'external_party_no_details') &&
        linkedCount !== 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resolutionActionIds'],
          message: 'לא ניתן לקשר פעולות עבור בחירה זו',
        });
      }
    }
    // External handling is independent of readiness -- ExternalPartyFields
    // is shown in CloseDialog at every readiness level, so this check is
    // unconditional (unlike the internal-owner check above).
    checkExternalHandlerNameRequiredOnSupply(data, ctx);
    checkReportedToOpsRecipient(data, ctx);
  });

export type CloseIncidentInput = z.infer<typeof closeIncidentSchema>;

export const reopenIncidentSchema = z
  .object({
    expectedVersion: z.number(),
    reason: nonBlank(2000, 'סיבת הפתיחה מחדש'),
    ...internalOwnerField,
    ...externalHandlerFields,
  })
  .superRefine((data, ctx) => {
    if (!data.ownerUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerUserId'],
        message: 'יש לבחור בעל אחריות פנימי',
      });
    }
    checkExternalHandlerNameRequiredOnSupply(data, ctx);
  });

export type ReopenIncidentInput = z.infer<typeof reopenIncidentSchema>;

export const cancelIncidentSchema = z.object({
  expectedVersion: z.number(),
  eventTime: z.string().min(1, 'יש להזין מועד ביטול'),
  cancellationReason: nonBlank(2000, 'סיבת הביטול'),
});

export type CancelIncidentInput = z.infer<typeof cancelIncidentSchema>;

export const assignIncidentSchema = z
  .object({
    expectedVersion: z.number(),
    note: z.string().max(1000).optional().default(''),
    ...internalOwnerField,
    ...externalHandlerFields,
  })
  .superRefine((data, ctx) => {
    if (!data.ownerUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerUserId'],
        message: 'יש לבחור בעל אחריות פנימי',
      });
    }
    checkExternalHandlerNameRequiredOnSupply(data, ctx);
  });

export type AssignIncidentInput = z.infer<typeof assignIncidentSchema>;

export const correctionSchema = z.object({
  refId: z.string().min(1),
  text: nonBlank(2000, 'תוכן התיקון'),
});

export type CorrectionInput = z.infer<typeof correctionSchema>;

export const roleSchema = z.enum([
  'system_admin',
  'professional_manager',
  'shift_supervisor',
  'technician',
  'viewer',
]);

/** Pre-provisioned personnel entry. The email is normalized (trim +
 *  lowercase) at parse time; the database enforces the same rule again. */
export const pendingPersonnelInputSchema = z.object({
  fullName: nonBlank(120, 'שם מלא'),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, 'כתובת הדוא״ל אינה תקינה')
    .max(320, 'כתובת הדוא״ל אינה תקינה')
    .refine((v) => v.indexOf('@') > 0, 'כתובת הדוא״ל אינה תקינה'),
  role: roleSchema,
  /** Optional expiry (ISO timestamp). Must be in the future at write time --
   *  the repository/database enforce that; expired entries are not
   *  claimable and are lazily retired when a replacement is created. */
  expiresAt: z.string().datetime({ offset: true, message: 'מועד התפוגה אינו תקין' }).nullish(),
});

export type PendingPersonnelInput = z.infer<typeof pendingPersonnelInputSchema>;

/** Renaming only -- pending entry or already-linked profile. Deliberately
 *  narrower than pendingPersonnelInputSchema's fullName rule (1-120 chars):
 *  2-60 characters after trimming, rejecting any embedded line break or
 *  control character -- otherwise any Unicode display-name text is
 *  accepted (Hebrew, English, parentheses, punctuation, hyphens,
 *  apostrophes, ...), never restricted to a narrow character allowlist or
 *  to ASCII. Mirrors admin_set_user_name/rename_pending_personnel
 *  (migration 0034) exactly, including trimming ONLY leading/trailing
 *  plain space characters (not other whitespace, e.g. tab/newline) --
 *  matching Postgres's own trim() default -- so a value with an edge or
 *  embedded tab/newline/control character is rejected outright rather
 *  than silently normalized away. */
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;
export const renamePersonnelInputSchema = z.object({
  fullName: z
    .string()
    .transform((v) => v.replace(/^ +| +$/g, ''))
    .superRefine((v, ctx) => {
      if (v.length < 2 || v.length > 60) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'שם: בין 2 ל-60 תווים' });
        return;
      }
      if (CONTROL_CHAR_RE.test(v)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'השם אינו יכול להכיל שורה חדשה או תווי בקרה' });
      }
    }),
});

export type RenamePersonnelInput = z.infer<typeof renamePersonnelInputSchema>;
