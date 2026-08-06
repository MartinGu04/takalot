// Fictional demo data only. No real systems, locations, incidents, or people.
import type { DemoDatabase } from './storage';
import { emptyDatabase } from './storage';
import type {
  Incident,
  IncidentCauseAssessment,
  IncidentClosureClassification,
  IncidentEvent,
  IncidentTreatmentAction,
  IncidentUpdate,
  Severity,
  IncidentStatus,
  IncidentDomain,
  SuspectedCause,
} from '../../domain/types';
import { jerusalemYear } from '../../lib/time';

const minutes = (n: number) => n * 60000;
const hours = (n: number) => n * 3600000;

export const DEMO_USERS = {
  admin: 'u-admin',
  manager: 'u-manager',
  supervisor1: 'u-supervisor-1',
  supervisor2: 'u-supervisor-2',
  tech1: 'u-tech-1',
  tech2: 'u-tech-2',
  viewer: 'u-viewer',
} as const;

export function buildSeed(now: Date = new Date()): DemoDatabase {
  const db = emptyDatabase();
  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();
  const year = jerusalemYear(now);
  const num = (n: number) => `${year}-${String(n).padStart(3, '0')}`;

  db.seededAt = now.toISOString();

  db.profiles = [
    { id: DEMO_USERS.admin, fullName: 'אלון ברק (דמו)', role: 'system_admin', active: true, createdAt: at(-hours(24 * 90)), operationalNotificationsEnabled: false },
    { id: DEMO_USERS.manager, fullName: 'דנה לוי (דמו)', role: 'professional_manager', active: true, createdAt: at(-hours(24 * 90)), operationalNotificationsEnabled: false },
    { id: DEMO_USERS.supervisor1, fullName: 'יואב כהן (דמו)', role: 'shift_supervisor', active: true, createdAt: at(-hours(24 * 60)), operationalNotificationsEnabled: false },
    { id: DEMO_USERS.supervisor2, fullName: 'מאיה רוזן (דמו)', role: 'shift_supervisor', active: true, createdAt: at(-hours(24 * 60)), operationalNotificationsEnabled: false },
    { id: DEMO_USERS.tech1, fullName: 'עומר פרץ (דמו)', role: 'technician', active: true, createdAt: at(-hours(24 * 45)), operationalNotificationsEnabled: false },
    { id: DEMO_USERS.tech2, fullName: 'ליאור אדרי (דמו)', role: 'technician', active: true, createdAt: at(-hours(24 * 45)), operationalNotificationsEnabled: false },
    { id: DEMO_USERS.viewer, fullName: 'רוני שגיא (דמו)', role: 'viewer', active: true, createdAt: at(-hours(24 * 30)), operationalNotificationsEnabled: false },
  ];

  db.systems = [
    { id: 'sys-alpha', name: 'מערכת אלפא', archived: false, category: 'platforms', displayOrder: 1, createdAt: at(-hours(24 * 90)) },
    { id: 'sys-beta', name: 'מערכת בטא', archived: false, category: 'station_systems', displayOrder: 1, createdAt: at(-hours(24 * 90)) },
    { id: 'sys-gamma', name: 'מערכת גמא', archived: false, category: 'computing', displayOrder: 1, createdAt: at(-hours(24 * 90)) },
    { id: 'sys-pos-a', name: 'עמדה א׳', archived: false, category: 'station_systems', displayOrder: 2, createdAt: at(-hours(24 * 90)) },
    { id: 'sys-pos-b', name: 'עמדה ב׳', archived: true, category: 'infrastructure', displayOrder: 1, createdAt: at(-hours(24 * 90)) },
  ];

  db.locations = [
    { id: 'loc-1', name: 'אתר 1', archived: false, category: 'unit_internal', displayOrder: 1, createdAt: at(-hours(24 * 90)) },
    { id: 'loc-2', name: 'אתר 2', archived: false, category: 'field_side', displayOrder: 1, createdAt: at(-hours(24 * 90)) },
    { id: 'loc-3', name: 'אתר 3', archived: false, category: 'external_bases', displayOrder: 1, createdAt: at(-hours(24 * 90)) },
    { id: 'loc-control', name: 'חדר בקרה ראשי', archived: false, category: 'unit_internal', displayOrder: 2, createdAt: at(-hours(24 * 90)) },
  ];

  interface SeedIncident {
    id: string;
    n: number;
    systemId: string;
    locationId: string;
    description: string;
    severity: Severity;
    status: IncidentStatus;
    impact: string;
    ownerUserId?: string;
    ownerExternalName?: string;
    externalHandlerName?: string;
    externalHandlerContactPerson?: string;
    externalHandlerContactDetails?: string;
    createdOffset: number;
    createdBy: string;
    nextUpdateOffset?: number | null;
    noDeadlineReason?: string;
    // Both default to null (never classified/assessed) -- a deliberate mix
    // across the fixtures below exercises the unclassified/unassessed
    // fallback rendering alongside the populated-label paths, and every
    // incident predating this feature is honestly represented this way,
    // never backfilled to a fabricated value.
    reportedDomain?: IncidentDomain | null;
    currentSuspectedCause?: SuspectedCause | null;
    currentSuspectedCauseOtherDetail?: string | null;
  }

  const mk = (s: SeedIncident): Incident => ({
    id: s.id,
    number: num(s.n),
    version: 1,
    systemId: s.systemId,
    locationId: s.locationId,
    description: s.description,
    severity: s.severity,
    status: s.status,
    operationalImpact: s.impact,
    ownerUserId: s.ownerUserId ?? null,
    ownerExternalName: s.ownerExternalName ?? null,
    externalHandlerName: s.externalHandlerName ?? null,
    externalHandlerContactPerson: s.externalHandlerContactPerson ?? null,
    externalHandlerContactDetails: s.externalHandlerContactDetails ?? null,
    discoveredAt: at(s.createdOffset - minutes(10)),
    createdAt: at(s.createdOffset),
    createdBy: s.createdBy,
    updatedAt: at(s.createdOffset),
    updatedBy: s.createdBy,
    lastUpdateAt: at(s.createdOffset),
    nextUpdateDue: s.nextUpdateOffset === null ? null : at(s.nextUpdateOffset ?? hours(4)),
    noDeadlineReason: s.noDeadlineReason ?? null,
    reportedToOps: 'yes',
    reportedToOpsRecipient: 'מוקד מבצעים (דמו)',
    // Opening-time-only questions default to לא -- individual demo
    // incidents below opt in explicitly, the same way version/lastUpdateAt
    // are overridden post-construction rather than threaded through
    // SeedIncident's own parameters.
    reportedToComms: false,
    reportedToCommsRecipient: null,
    wisdomReported: false,
    wisdomIncidentNumber: null,
    closedAt: null,
    closedBy: null,
    rootCause: null,
    resolution: null,
    readinessAtClose: null,
    followUpNotes: null,
    followUpRequired: false,
    followUpCompletedAt: null,
    followUpCompletedBy: null,
    reopenCount: 0,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
    reportedDomain: s.reportedDomain ?? null,
    currentSuspectedCause: s.currentSuspectedCause ?? null,
    currentSuspectedCauseOtherDetail: s.currentSuspectedCauseOtherDetail ?? null,
  });

  const ev = (
    id: string,
    incidentId: string,
    type: IncidentEvent['type'],
    actorId: string,
    offset: number,
    extra: Partial<IncidentEvent> = {},
  ): IncidentEvent => ({
    id,
    incidentId,
    type,
    actorId,
    actorLabel: null,
    eventTime: at(offset),
    serverTime: at(offset),
    field: null,
    oldValue: null,
    newValue: null,
    note: null,
    userNote: null,
    refId: null,
    createdAt: at(offset),
    // Seed data represents pre-existing history, exactly like any real
    // incident predating operation grouping: operationId is null unless a
    // caller deliberately overrides it.
    operationId: null,
    ...extra,
  });

  // 1. Critical, overdue, in progress
  const inc1 = mk({
    id: 'inc-1',
    n: 1,
    systemId: 'sys-alpha',
    locationId: 'loc-1',
    description: 'מערכת אלפא אינה מגיבה לפקודות הפעלה. בוצע ניסיון אתחול מרחוק ללא הצלחה. קוד שגיאה E-401 מופיע במסך הראשי.',
    severity: 'critical',
    status: 'in_progress',
    impact: 'אין יכולת הפעלה מלאה של מערכת אלפא. נדרש מעקף ידני.',
    ownerUserId: DEMO_USERS.tech1,
    createdOffset: -hours(6),
    createdBy: DEMO_USERS.supervisor1,
    nextUpdateOffset: -minutes(45),
    reportedDomain: 'equipment',
    currentSuspectedCause: 'equipment',
  });
  inc1.version = 3;
  inc1.lastUpdateAt = at(-hours(2));
  inc1.updatedAt = at(-hours(2));

  // 2. High severity, in progress, not overdue
  const inc2 = mk({
    id: 'inc-2',
    n: 2,
    systemId: 'sys-beta',
    locationId: 'loc-2',
    description: 'תקשורת בין מערכת בטא לעמדת הבקרה מתנתקת לסירוגין, בממוצע פעם בשעה. ייתכן כשל בכבל או בממיר.',
    severity: 'high',
    status: 'in_progress',
    impact: 'עיכוב בקבלת נתונים בעמדת הבקרה. עבודה ממשיכה במתכונת חלקית.',
    ownerUserId: DEMO_USERS.tech2,
    createdOffset: -hours(9),
    createdBy: DEMO_USERS.supervisor2,
    nextUpdateOffset: hours(2),
    reportedDomain: 'communications',
    // Deliberately left unassessed -- demonstrates the "לא הוזנה הערכת
    // גורם" fallback, distinct from the explicit 'unknown' value (inc4).
  });
  inc2.version = 2;
  inc2.lastUpdateAt = at(-hours(3));
  inc2.updatedAt = at(-hours(3));
  inc2.reportedToComms = true;
  inc2.reportedToCommsRecipient = 'תקשוב מוקד מבצעים (דמו)';

  // 3. Waiting for external party
  const inc3 = mk({
    id: 'inc-3',
    n: 3,
    systemId: 'sys-gamma',
    locationId: 'loc-3',
    description: 'רכיב הזנה במערכת גמא הפסיק לעבוד. נדרש רכיב חלופי מהספק. הוזמן טכנאי חיצוני.',
    severity: 'medium',
    status: 'waiting_external',
    impact: 'מערכת גמא עובדת במצב גיבוי. אין פגיעה מיידית בפעילות.',
    ownerExternalName: 'טכנאי מטעם ספק (חברת דוגמה בע״מ)',
    // Mirrors the migration-time backfill (0032): every legacy external-only
    // incident (owner_user_id null, owner_external_name set) gets this value
    // copied into externalHandlerName, open incidents included.
    externalHandlerName: 'טכנאי מטעם ספק (חברת דוגמה בע״מ)',
    createdOffset: -hours(30),
    createdBy: DEMO_USERS.supervisor1,
    nextUpdateOffset: hours(20),
    // reportedDomain intentionally left null -- demonstrates the "לא סווג
    // בעת פתיחת התקלה" fallback for an incident opened before this
    // feature (or via the still-permissive legacy create_incident RPC).
  });
  inc3.version = 2;
  inc3.lastUpdateAt = at(-hours(5));
  inc3.updatedAt = at(-hours(5));

  // 4. Monitoring
  const inc4 = mk({
    id: 'inc-4',
    n: 4,
    systemId: 'sys-pos-a',
    locationId: 'loc-control',
    description: 'בעמדה א׳ נצפתה התחממות קלה מעל הסף המומלץ. בוצע ניקוי פתחי אוורור והטמפרטורה התייצבה.',
    severity: 'low',
    status: 'monitoring',
    impact: 'אין פגיעה תפקודית. במעקב טמפרטורה כל שעתיים.',
    ownerUserId: DEMO_USERS.supervisor1,
    createdOffset: -hours(20),
    createdBy: DEMO_USERS.supervisor1,
    nextUpdateOffset: hours(12),
    reportedDomain: 'infrastructure',
    // Explicit 'unknown' -- an active assessment concluding "not yet
    // known", rendered "הגורם טרם ידוע"; distinct from inc2's unassessed
    // (null) fallback above.
    currentSuspectedCause: 'unknown',
  });
  inc4.version = 2;
  inc4.lastUpdateAt = at(-hours(8));
  inc4.wisdomReported = true;
  inc4.wisdomIncidentNumber = 'WISDOM-2026-0412';
  inc4.updatedAt = at(-hours(8));

  // 5. Closed with full readiness
  const inc5 = mk({
    id: 'inc-5',
    n: 5,
    systemId: 'sys-beta',
    locationId: 'loc-1',
    description: 'שגיאת תצורה לאחר עדכון גרסה במערכת בטא. המערכת לא עלתה לאחר האתחול.',
    severity: 'high',
    status: 'closed',
    impact: 'מערכת בטא הושבתה לחלוטין למשך הטיפול.',
    ownerUserId: DEMO_USERS.tech1,
    createdOffset: -hours(50),
    createdBy: DEMO_USERS.supervisor2,
    nextUpdateOffset: null,
    noDeadlineReason: 'התקלה נסגרה',
    reportedDomain: 'software',
    currentSuspectedCause: 'software',
  });
  inc5.version = 3;
  inc5.closedAt = at(-hours(44));
  inc5.closedBy = DEMO_USERS.supervisor2;
  inc5.rootCause = 'קובץ תצורה שגוי שהותקן במהלך עדכון הגרסה.';
  inc5.resolution = 'שוחזר קובץ התצורה הקודם, בוצע אתחול מסודר ואומתה עליית המערכת.';
  inc5.readinessAtClose = 'full';
  inc5.lastUpdateAt = at(-hours(44));
  inc5.updatedAt = at(-hours(44));
  inc5.nextUpdateDue = null;

  // 6. Historical record: closed with partial readiness, follow-up required.
  // Predates the incomplete-readiness lifecycle policy (an incident with
  // partial/no readiness can no longer be marked "closed" going forward --
  // see inc8 for the current behavior). Preserved as-is: history is never
  // silently rewritten or deleted.
  const inc6 = mk({
    id: 'inc-6',
    n: 6,
    systemId: 'sys-alpha',
    locationId: 'loc-2',
    description: 'אנטנת משנה של מערכת אלפא באתר 2 ניזוקה. הותקן פתרון זמני עם רכיב חלופי בעל ביצועים מופחתים.',
    severity: 'medium',
    status: 'closed',
    impact: 'טווח הקליטה מופחת בכ־20% עד להתקנת רכיב קבוע.',
    ownerUserId: DEMO_USERS.tech2,
    createdOffset: -hours(72),
    createdBy: DEMO_USERS.manager,
    nextUpdateOffset: null,
    noDeadlineReason: 'התקלה נסגרה',
  });
  inc6.version = 3;
  inc6.closedAt = at(-hours(60));
  inc6.closedBy = DEMO_USERS.manager;
  inc6.rootCause = 'נזק פיזי לרכיב האנטנה כתוצאה ממזג אוויר.';
  inc6.resolution = 'הותקן רכיב חלופי זמני. הוזמן רכיב קבוע מהספק.';
  inc6.readinessAtClose = 'partial';
  inc6.followUpNotes = 'להתקין רכיב קבוע עם הגעתו מהספק ולאמת חזרה לביצועים מלאים.';
  inc6.followUpRequired = true;
  inc6.lastUpdateAt = at(-hours(60));
  inc6.updatedAt = at(-hours(60));
  inc6.nextUpdateDue = null;

  // 7. Reopened incident
  const inc7 = mk({
    id: 'inc-7',
    n: 7,
    systemId: 'sys-gamma',
    locationId: 'loc-control',
    description: 'תצוגת הנתונים בחדר הבקרה קופאת מדי פעם ודורשת רענון ידני. טופל ונסגר, אך התופעה חזרה.',
    severity: 'medium',
    status: 'reopened',
    impact: 'נדרש רענון ידני של התצוגה. עומס על צוות הבקרה.',
    ownerUserId: DEMO_USERS.tech1,
    createdOffset: -hours(96),
    createdBy: DEMO_USERS.supervisor2,
    nextUpdateOffset: hours(6),
    reportedDomain: 'software',
    // currentSuspectedCause stays null: reopening resets the denormalized
    // mirror, so the reopened cycle begins with no current assessment --
    // never carrying the pre-reopen cause (or the closure's own confirmed
    // cause, see the incidentClosures fixture below) forward.
  });
  inc7.version = 5;
  inc7.reopenCount = 1;
  inc7.lastUpdateAt = at(-hours(1));
  inc7.updatedAt = at(-hours(1));

  // 8. Attempted closure with partial readiness under the current policy:
  // stays active as "כשירות חלקית" rather than closing, with a responsible
  // owner and follow-up notes recorded.
  const inc8 = mk({
    id: 'inc-8',
    n: 8,
    systemId: 'sys-pos-a',
    locationId: 'loc-2',
    description: 'לאחר טיפול בעמדה א׳ בוצע ניסיון סגירה, אך התברר כי הביצועים לא חזרו לרמה המלאה.',
    severity: 'medium',
    status: 'partial_readiness',
    impact: 'העמדה פועלת בביצועים מופחתים עד השלמת פעולות ההמשך.',
    ownerUserId: DEMO_USERS.tech2,
    createdOffset: -hours(40),
    createdBy: DEMO_USERS.supervisor2,
    nextUpdateOffset: null,
    reportedDomain: 'equipment',
    currentSuspectedCause: 'equipment',
  });
  inc8.version = 2;
  inc8.rootCause = 'רכיב בלאי בעמדה א׳ לא הוחלף במלואו.';
  inc8.resolution = 'הותקן רכיב חלופי זמני בעל ביצועים מופחתים.';
  inc8.followUpNotes = 'להזמין רכיב מקורי ולהתקינו לצורך חזרה לכשירות מלאה.';
  inc8.followUpRequired = true;
  inc8.noDeadlineReason = 'התקלה נותרה פעילה עם כשירות לא מלאה, ממתינה להשלמת פעולות המשך';
  inc8.lastUpdateAt = at(-hours(30));
  inc8.updatedAt = at(-hours(30));

  // 9. Historical record: closed, legacy external-only (no internal owner
  // at all -- owner_external_name is its sole historical owner fact).
  // externalHandlerName mirrors the migration-time backfill (0032): a real
  // hosted database copies owner_external_name into externalHandlerName for
  // every legacy external-only incident, open or closed alike, so this
  // fixture reflects that already-backfilled state rather than a pre-PR-C
  // one -- covering the terminal-incident half of that backfill's scope
  // (inc3, above, is the still-open half).
  const inc9 = mk({
    id: 'inc-9',
    n: 9,
    systemId: 'sys-alpha',
    locationId: 'loc-3',
    description: 'תקלה היסטורית שטופלה במלואה על ידי גורם חיצוני, ללא בעל אחריות פנימי, עוד לפני הנהגת המודל הנוכחי.',
    severity: 'low',
    status: 'closed',
    impact: 'לא הייתה פגיעה תפקודית מתמשכת.',
    ownerExternalName: 'טכנאי מטעם ספק (רישום היסטורי)',
    externalHandlerName: 'טכנאי מטעם ספק (רישום היסטורי)',
    createdOffset: -hours(500),
    createdBy: DEMO_USERS.supervisor1,
    nextUpdateOffset: null,
    noDeadlineReason: 'התקלה נסגרה',
  });
  inc9.version = 2;
  inc9.closedAt = at(-hours(490));
  inc9.closedBy = DEMO_USERS.supervisor1;
  inc9.rootCause = 'תקלה בציוד שסופק על ידי הגורם החיצוני.';
  inc9.resolution = 'הגורם החיצוני ביצע החלפה מלאה של הציוד הפגום.';
  inc9.readinessAtClose = 'full';
  inc9.lastUpdateAt = at(-hours(490));
  inc9.updatedAt = at(-hours(490));

  db.incidents = [inc1, inc2, inc3, inc4, inc5, inc6, inc7, inc8, inc9];
  db.sequences[String(year)] = 9;

  // --- updates & events ---
  const updates: IncidentUpdate[] = [
    {
      id: 'upd-1a',
      incidentId: 'inc-1',
      authorId: DEMO_USERS.tech1,
      eventTime: at(-hours(4)),
      serverTime: at(-hours(4)),
      actionsTaken: 'בוצעה בדיקת ספקי מתח וכבלי חיבור. הוחלף כבל חשוד בעמדת ההפעלה.',
      findings: 'קוד השגיאה E-401 ממשיך להופיע גם לאחר החלפת הכבל.',
      nextSteps: 'בדיקת כרטיס התקשורת הראשי מול תיעוד היצרן.',
      currentStatusText: 'הצוות הטכני באתר, בודק את כרטיס התקשורת.',
      updateReportedToOps: 'yes',
      updateReportedToOpsRecipient: 'אחמ״ש מוקד מבצעים (דמו)',
      updateReportedToComms: true,
      updateReportedToCommsRecipient: 'תקשוב מוקד מבצעים (דמו)',
      updateWisdomReported: false,
      userNote: null,
      createdAt: at(-hours(4)),
    },
    {
      id: 'upd-1b',
      incidentId: 'inc-1',
      authorId: DEMO_USERS.tech1,
      eventTime: at(-hours(2)),
      serverTime: at(-hours(2)),
      actionsTaken: 'פורק כרטיס התקשורת ונבדק חיבור פנימי. נמצא פין עקום בחיבור המרכזי.',
      findings: 'ייתכן שהפין העקום הוא מקור התקלה. נדרש רכיב חלופי מהמלאי.',
      nextSteps: 'איתור כרטיס חלופי והתקנתו.',
      currentStatusText: 'ממתינים לרכיב חלופי מהמלאי המרכזי.',
      updateReportedToOps: 'not_required',
      updateReportedToOpsRecipient: null,
      updateReportedToComms: false,
      updateReportedToCommsRecipient: null,
      updateWisdomReported: true,
      userNote: 'יש לתאם עם הספק את מועד אספקת הרכיב מראש.',
      createdAt: at(-hours(2)),
    },
    {
      id: 'upd-2a',
      incidentId: 'inc-2',
      authorId: DEMO_USERS.tech2,
      eventTime: at(-hours(3)),
      serverTime: at(-hours(3)),
      actionsTaken: 'הוחלף ממיר התקשורת בעמדת הבקרה ובוצע ניטור של שעה.',
      findings: 'מאז ההחלפה לא נצפו ניתוקים. ממשיכים בניטור.',
      nextSteps: 'ניטור נוסף של 4 שעות לפני סגירה.',
      currentStatusText: 'המערכת יציבה, בניטור מעקב.',
      updateReportedToOps: 'no',
      updateReportedToOpsRecipient: null,
      updateReportedToComms: false,
      updateReportedToCommsRecipient: null,
      updateWisdomReported: false,
      userNote: null,
      createdAt: at(-hours(3)),
    },
    {
      // Deliberately left without currentStatusText or any update-specific
      // reporting answer: exercises the historical/legacy render path (a
      // record predating these fields, or one where an old-client payload
      // omitted them).
      id: 'upd-7a',
      incidentId: 'inc-7',
      authorId: DEMO_USERS.tech1,
      eventTime: at(-hours(1)),
      serverTime: at(-hours(1)),
      actionsTaken: 'נאספו קובצי יומן מהתצוגה לאחר הישנות התופעה.',
      findings: 'הקפיאות מתרחשות בזמן ריענון נתונים אוטומטי בשעה עגולה.',
      nextSteps: 'בדיקת תהליך הריענון האוטומטי מול הגדרות התצורה.',
      currentStatusText: null,
      updateReportedToOps: null,
      updateReportedToOpsRecipient: null,
      updateReportedToComms: null,
      updateReportedToCommsRecipient: null,
      updateWisdomReported: null,
      userNote: null,
      createdAt: at(-hours(1)),
    },
  ];
  db.incidentUpdates = updates;

  db.incidentEvents = [
    ev('ev-1-created', 'inc-1', 'created', DEMO_USERS.supervisor1, -hours(6), {
      note: 'פתיחת תקלה',
      userNote: 'התקלה דווחה טלפונית על ידי מפעיל המשמרת.',
      // Deliberately null (unlike ev-1-upd-a/b below): this exact row is
      // also the fixture for "a historical seeded event reads back with
      // operationId null" -- kept representing genuinely pre-operation-
      // grouping legacy data, so the initial cause assessment below (ca-1-1)
      // is deliberately not joined to it via operationId either.
    }),
    ev('ev-1-ack', 'inc-1', 'acknowledged', DEMO_USERS.supervisor1, -hours(6) + minutes(5)),
    ev('ev-1-assign', 'inc-1', 'assignment_change', DEMO_USERS.supervisor1, -hours(6) + minutes(10), {
      field: 'owner', oldValue: 'יואב כהן (דמו)', newValue: 'עומר פרץ (דמו)',
    }),
    ev('ev-1-upd-a', 'inc-1', 'update', DEMO_USERS.tech1, -hours(4), { refId: 'upd-1a', operationId: 'op-1-upd-a' }),
    ev('ev-1-upd-b', 'inc-1', 'update', DEMO_USERS.tech1, -hours(2), { refId: 'upd-1b', operationId: 'op-1-upd-b' }),
    ev('ev-2-created', 'inc-2', 'created', DEMO_USERS.supervisor2, -hours(9)),
    ev('ev-2-upd-a', 'inc-2', 'update', DEMO_USERS.tech2, -hours(3), { refId: 'upd-2a' }),
    ev('ev-3-created', 'inc-3', 'created', DEMO_USERS.supervisor1, -hours(30)),
    ev('ev-3-status', 'inc-3', 'status_change', DEMO_USERS.supervisor1, -hours(5), {
      field: 'status', oldValue: 'in_progress', newValue: 'waiting_external',
      note: 'ממתינים להגעת טכנאי הספק עם רכיב חלופי.',
    }),
    ev('ev-4-created', 'inc-4', 'created', DEMO_USERS.supervisor1, -hours(20)),
    ev('ev-4-status', 'inc-4', 'status_change', DEMO_USERS.supervisor1, -hours(8), {
      field: 'status', oldValue: 'in_progress', newValue: 'monitoring',
      note: 'הטמפרטורה התייצבה. מעקב כל שעתיים.',
    }),
    ev('ev-5-created', 'inc-5', 'created', DEMO_USERS.supervisor2, -hours(50)),
    ev('ev-5-closed', 'inc-5', 'closed', DEMO_USERS.supervisor2, -hours(44), {
      note: 'שוחזר קובץ תצורה קודם והמערכת חזרה לכשירות מלאה.',
      newValue: 'full',
      refId: 'clo-5-1',
      operationId: 'op-5-closed',
    }),
    ev('ev-6-created', 'inc-6', 'created', DEMO_USERS.manager, -hours(72)),
    ev('ev-6-closed', 'inc-6', 'closed', DEMO_USERS.manager, -hours(60), {
      note: 'הותקן פתרון זמני. נדרשות פעולות המשך להתקנת רכיב קבוע.',
      newValue: 'partial',
      // No refId: this record predates structured closure classification
      // (see inc6's own comment above) -- exercises the "closed, no
      // classification" fallback, same rendering as a true legacy row.
    }),
    ev('ev-7-created', 'inc-7', 'created', DEMO_USERS.supervisor2, -hours(96)),
    ev('ev-7-closed', 'inc-7', 'closed', DEMO_USERS.supervisor2, -hours(48), {
      note: 'בוצע עדכון תוכנה לתצוגה והתופעה לא חזרה במשך יומיים.',
      newValue: 'full',
      refId: 'clo-7-1',
      operationId: 'op-7-closed',
    }),
    ev('ev-7-reopened', 'inc-7', 'reopened', DEMO_USERS.manager, -hours(3), {
      note: 'התופעה חזרה: התצוגה קפאה פעמיים במשמרת האחרונה.',
    }),
    ev('ev-7-upd-a', 'inc-7', 'update', DEMO_USERS.tech1, -hours(1), { refId: 'upd-7a' }),
    ev('ev-8-created', 'inc-8', 'created', DEMO_USERS.supervisor2, -hours(40)),
    ev('ev-8-status', 'inc-8', 'status_change', DEMO_USERS.supervisor2, -hours(30), {
      field: 'status',
      oldValue: 'in_progress',
      newValue: 'partial_readiness',
      note: 'סיבת התקלה: רכיב בלאי בעמדה א׳ לא הוחלף במלואו.\nהפתרון החלקי שבוצע: הותקן רכיב חלופי זמני בעל ביצועים מופחתים.\nפעולות המשך: להזמין רכיב מקורי ולהתקינו לצורך חזרה לכשירות מלאה.\nגורם מטפל אחראי המשך: ליאור אדרי (דמו)',
    }),
  ];

  // --- structured lifecycle classification fixtures ---
  // A deliberate mix: inc1 shows the full create->update classification
  // trail; inc5/inc7 show a genuine closure's classification (inc7's
  // belongs to the CYCLE BEFORE its reopen, demonstrating that reopening
  // preserves it untouched); inc2/inc3/inc4/inc6/inc8/inc9 are left
  // without some or all of this data to exercise the unclassified/
  // unassessed/no-classification fallbacks.
  const causeAssessments: IncidentCauseAssessment[] = [
    {
      id: 'ca-1-1',
      incidentId: 'inc-1',
      cause: 'equipment',
      otherDetail: null,
      cycleNumber: 0,
      recordedBy: DEMO_USERS.supervisor1,
      eventTime: null,
      recordedAt: at(-hours(6)),
      // Deliberately null, matching ev-1-created's own null operationId
      // above (kept representing genuinely legacy, pre-operation-grouping
      // data) -- inc-5's closure classification below demonstrates the
      // operationId join instead.
      operationId: null,
      createdAt: at(-hours(6)),
    },
  ];
  db.incidentCauseAssessments = causeAssessments;

  const treatmentActions: IncidentTreatmentAction[] = [
    {
      id: 'ta-1-1',
      incidentId: 'inc-1',
      actionType: 'reset_restart',
      otherDetail: null,
      cycleNumber: 0,
      eventTime: at(-hours(4)),
      recordedBy: DEMO_USERS.tech1,
      recordedAt: at(-hours(4)),
      operationId: 'op-1-upd-a',
      createdAt: at(-hours(4)),
    },
    {
      id: 'ta-1-2',
      incidentId: 'inc-1',
      actionType: 'equipment_replacement',
      otherDetail: null,
      cycleNumber: 0,
      eventTime: at(-hours(2)),
      recordedBy: DEMO_USERS.tech1,
      recordedAt: at(-hours(2)),
      operationId: 'op-1-upd-b',
      createdAt: at(-hours(2)),
    },
    {
      id: 'ta-5-1',
      incidentId: 'inc-5',
      actionType: 'config_change',
      otherDetail: null,
      cycleNumber: 0,
      eventTime: at(-hours(44)),
      recordedBy: DEMO_USERS.supervisor2,
      recordedAt: at(-hours(44)),
      operationId: 'op-5-closed',
      createdAt: at(-hours(44)),
    },
    {
      id: 'ta-7-1',
      incidentId: 'inc-7',
      actionType: 'software_fix',
      otherDetail: null,
      cycleNumber: 0,
      eventTime: at(-hours(48)),
      recordedBy: DEMO_USERS.supervisor2,
      recordedAt: at(-hours(48)),
      operationId: 'op-7-closed',
      createdAt: at(-hours(48)),
    },
  ];
  db.incidentTreatmentActions = treatmentActions;

  const closures: IncidentClosureClassification[] = [
    {
      id: 'clo-5-1',
      incidentId: 'inc-5',
      cycleNumber: 0,
      operationId: 'op-5-closed',
      confirmedCause: 'software',
      confirmedCauseOtherDetail: null,
      treatmentOutcome: 'permanent_resolution',
      treatmentOutcomeOtherDetail: null,
      resolutionAttribution: 'specific_action',
      resolutionAttributionOtherDetail: null,
      resolutionActionIds: ['ta-5-1'],
      recordedBy: DEMO_USERS.supervisor2,
      eventTime: at(-hours(44)),
      recordedAt: at(-hours(44)),
      createdAt: at(-hours(44)),
    },
    {
      // Belongs to inc-7's CYCLE 0 -- the closure that preceded its later
      // reopen. Preserved untouched: still visible here even though the
      // incident is now on cycle 1 (reopenCount === 1) with no current
      // classification of its own yet.
      id: 'clo-7-1',
      incidentId: 'inc-7',
      cycleNumber: 0,
      operationId: 'op-7-closed',
      confirmedCause: 'software',
      confirmedCauseOtherDetail: null,
      treatmentOutcome: 'temporary_workaround',
      treatmentOutcomeOtherDetail: null,
      resolutionAttribution: 'specific_action',
      resolutionAttributionOtherDetail: null,
      resolutionActionIds: ['ta-7-1'],
      recordedBy: DEMO_USERS.supervisor2,
      eventTime: at(-hours(48)),
      recordedAt: at(-hours(48)),
      createdAt: at(-hours(48)),
    },
  ];
  db.incidentClosures = closures;

  db.notifications = [
    {
      id: 'ntf-2',
      userId: DEMO_USERS.tech1,
      type: 'incident_assigned',
      category: 'action_required',
      incidentId: 'inc-7',
      handoverId: null,
      text: `תקלה ${num(7)} הוקצתה אליך לאחר פתיחה מחדש.`,
      read: false,
      createdAt: at(-hours(3)),
      dedupeKey: 'assign-inc-7-reopen',
    },
    {
      id: 'ntf-3',
      userId: DEMO_USERS.manager,
      type: 'incident_opened',
      category: 'update',
      incidentId: 'inc-7',
      handoverId: null,
      text: `נפתחה תקלה ${num(7)} · מערכת גמא · חדר בקרה ראשי`,
      read: true,
      createdAt: at(-hours(5)),
      dedupeKey: 'pm-seed-op-1-manager',
    },
  ];

  db.auditLogs = [
    {
      id: 'aud-seed-1',
      actorId: null,
      actorDisplayName: null,
      actorEmail: null,
      action: 'demo_seed',
      entityType: 'database',
      entityId: 'demo',
      entityLabel: null,
      summary: null,
      incidentNumber: null,
      before: null,
      after: JSON.stringify({ note: 'נתוני הדגמה פיקטיביים נטענו' }),
      metadata: null,
      correlationId: null,
      createdAt: now.toISOString(),
    },
  ];

  return db;
}
