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
]);
export const reportedToOpsSchema = z.enum(['yes', 'no', 'not_required']);
export const readinessSchema = z.enum(['full', 'partial', 'none']);

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
    description: nonBlank(4000, 'תיאור התקלה'),
    severity: severitySchema,
    operationalImpact: nonBlank(1000, 'השפעה מבצעית'),
    actionsTaken: nonBlank(4000, 'פעולות שבוצעו עד כה'),
    status: statusSchema.refine((s) => s !== 'closed' && s !== 'reopened', {
      message: 'סטטוס פתיחה חייב להיות סטטוס פעיל',
    }),
    nextUpdateDue: z.string().nullable(),
    noDeadlineReason: z.string().max(500).nullable(),
    ...ownerFields,
    ...reportedToOpsFields,
  })
  .superRefine((data, ctx) => {
    if (!data.ownerUserId && !(data.ownerExternalName ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerUserId'],
        message: 'יש לבחור גורם מטפל פנימי או להזין שם גורם חיצוני',
      });
    }
    if (!data.nextUpdateDue && !(data.noDeadlineReason ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nextUpdateDue'],
        message: 'יש להזין צפי לעדכון הבא, או לסמן "ללא צפי כרגע" עם נימוק',
      });
    }
    checkReportedToOpsRecipient(data, ctx);
  });

export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;

export const updateIncidentSchema = z
  .object({
    expectedVersion: z.number(),
    eventTime: z.string().min(1, 'יש להזין שעת עדכון'),
    actionsTaken: nonBlank(4000, 'פעולות שבוצעו'),
    findings: optionalText(4000, 'ממצאים'),
    nextSteps: optionalText(2000, 'פעולות המשך'),
    status: statusSchema,
    severity: severitySchema,
    operationalImpact: nonBlank(1000, 'השפעה מבצעית'),
    changeReason: z.string().max(500).optional().default(''),
    nextUpdateDue: z.string().nullable(),
    noDeadlineReason: z.string().max(500).nullable(),
    ...ownerFields,
    ...reportedToOpsFields,
  })
  .superRefine((data, ctx) => {
    if (!data.ownerUserId && !(data.ownerExternalName ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerUserId'],
        message: 'יש לבחור גורם מטפל פנימי או להזין שם גורם חיצוני',
      });
    }
    if (!data.nextUpdateDue && !(data.noDeadlineReason ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nextUpdateDue'],
        message: 'יש להזין צפי לעדכון הבא, או לסמן "ללא צפי כרגע" עם נימוק',
      });
    }
    checkReportedToOpsRecipient(data, ctx);
  });

export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>;

/** Technician updates: content only, no protected fields. */
export const technicianUpdateSchema = z.object({
  expectedVersion: z.number(),
  eventTime: z.string().min(1, 'יש להזין שעת עדכון'),
  actionsTaken: nonBlank(4000, 'פעולות שבוצעו'),
  findings: optionalText(4000, 'ממצאים'),
  nextSteps: optionalText(2000, 'הצעות להמשך'),
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
    nextUpdateDue: z.string().min(1, 'יש להזין צפי לעדכון הבא'),
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
