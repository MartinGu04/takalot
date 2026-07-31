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

/** Owner fields that may be entirely omitted (used where an owner is only conditionally required). */
const optionalOwnerFields = {
  ownerUserId: z.string().nullable().optional(),
  ownerExternalName: z.string().max(120, 'שם גורם חיצוני: עד 120 תווים').nullable().optional(),
};

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
  })
  .superRefine((data, ctx) => {
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
    ...ownerFields,
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
  })
  .superRefine((data, ctx) => {
    if (!data.ownerUserId && !(data.ownerExternalName ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerUserId'],
        message: 'יש לבחור גורם מטפל פנימי או להזין שם גורם חיצוני',
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

/** Technician updates: content only, no protected fields. */
export const technicianUpdateSchema = z.object({
  expectedVersion: z.number(),
  eventTime: z.string().min(1, 'יש להזין שעת עדכון'),
  actionsTaken: nonBlank(4000, 'פעולות שבוצעו'),
  findings: optionalText(4000, 'ממצאים'),
  nextSteps: optionalText(2000, 'הצעות להמשך'),
  currentStatusText: nonBlank(1000, 'סטטוס נוכחי'),
});

export type TechnicianUpdateInput = z.infer<typeof technicianUpdateSchema>;

export const closeIncidentSchema = z
  .object({
    expectedVersion: z.number(),
    rootCause: nonBlank(2000, 'סיבת התקלה'),
    resolution: nonBlank(4000, 'הפתרון שבוצע'),
    readiness: readinessSchema,
    followUpNotes: z.string().max(2000).optional().default(''),
    ...optionalOwnerFields,
    ...reportedToOpsFields,
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
      if (!data.ownerUserId && !(data.ownerExternalName ?? '').trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ownerUserId'],
          message: 'כאשר הכשירות אינה מלאה יש לקבוע גורם מטפל אחראי המשך',
        });
      }
    }
    checkReportedToOpsRecipient(data, ctx);
  });

export type CloseIncidentInput = z.infer<typeof closeIncidentSchema>;

export const reopenIncidentSchema = z
  .object({
    expectedVersion: z.number(),
    reason: nonBlank(2000, 'סיבת הפתיחה מחדש'),
    ...ownerFields,
  })
  .superRefine((data, ctx) => {
    if (!data.ownerUserId && !(data.ownerExternalName ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerUserId'],
        message: 'יש לבחור גורם מטפל לתקלה שנפתחת מחדש',
      });
    }
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
    ...ownerFields,
  })
  .superRefine((data, ctx) => {
    if (!data.ownerUserId && !(data.ownerExternalName ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerUserId'],
        message: 'יש לבחור גורם מטפל פנימי או להזין שם גורם חיצוני',
      });
    }
  });

export type AssignIncidentInput = z.infer<typeof assignIncidentSchema>;

export const correctionSchema = z.object({
  refId: z.string().min(1),
  text: nonBlank(2000, 'תוכן התיקון'),
});

export type CorrectionInput = z.infer<typeof correctionSchema>;

export const createHandoverSchema = z.object({
  toUserId: z.string().min(1, 'יש לבחור אחמ״ש נכנס'),
  generalNote: z.string().max(2000, 'הערה כללית: עד 2000 תווים').optional().default(''),
  itemNotes: z.record(z.string().max(1000)).default({}),
});

export type CreateHandoverInput = z.infer<typeof createHandoverSchema>;

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
