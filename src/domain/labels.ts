// Hebrew labels for all fixed enums. UI text lives here; code identifiers stay English.
import type {
  Role,
  Severity,
  IncidentStatus,
  Readiness,
  ReportedToOps,
  EventType,
  NotificationType,
  NotificationCategory,
  SystemCategory,
  LocationCategory,
  IncidentDomain,
  SuspectedCause,
  TreatmentActionType,
  ConfirmedCause,
  TreatmentOutcome,
  ResolutionAttribution,
} from './types';

export const APP_NAME = 'AVARIA';
export const APP_TAGLINE = 'מערכת ניהול ומעקב תקלות';

export const roleLabels: Record<Role, string> = {
  system_admin: 'מנהל מערכת',
  professional_manager: 'נגד / מנהל מקצועי',
  shift_supervisor: 'אחמ״ש',
  technician: 'טכנאי',
  viewer: 'צפייה בלבד',
};

/** Short role labels -- deliberately more compact than roleLabels (e.g.
 *  "נגד" instead of "נגד / מנהל מקצועי"). Used by the כוח אדם (personnel)
 *  page and by OwnerField's owner-group headings (the approved internal-owner
 *  picker group label is "נגד", not "נגד / מנהל מקצועי"); roleLabels stays
 *  as the general-purpose label used elsewhere in the app. */
export const personnelRoleLabels: Record<Role, string> = {
  system_admin: 'מנהל מערכת',
  professional_manager: 'נגד',
  shift_supervisor: 'אחמ״ש',
  technician: 'טכנאי',
  viewer: 'צפייה בלבד',
};

export const personnelStatusLabels: Record<'pending' | 'active' | 'inactive' | 'deleted', string> = {
  pending: 'ממתין להתחברות',
  active: 'פעיל',
  inactive: 'לא פעיל',
  deleted: 'נמחק',
};

export const severityLabels: Record<Severity, string> = {
  critical: 'קריטית',
  high: 'גבוהה',
  medium: 'בינונית',
  low: 'נמוכה',
};

export const statusLabels: Record<IncidentStatus, string> = {
  new: 'חדשה',
  acknowledged: 'התקבלה',
  in_progress: 'בטיפול',
  waiting_external: 'ממתינה לגורם חיצוני',
  waiting_test: 'ממתינה לבדיקה',
  monitoring: 'במעקב',
  partial_readiness: 'כשירות חלקית',
  resolved_pending_close: 'נפתרה, ממתינה לסגירה',
  closed: 'נסגרה',
  reopened: 'נפתחה מחדש',
  cancelled: 'בוטלה',
  waiting_equipment: 'ממתינה לציוד',
  waiting_information: 'ממתינה למידע',
  waiting_validation: 'ממתינה לאימות',
};

export const readinessLabels: Record<Readiness, string> = {
  full: 'מלאה',
  partial: 'חלקית',
  none: 'לא חזרה לכשירות',
};

export const reportedToOpsLabels: Record<ReportedToOps, string> = {
  yes: 'כן',
  no: 'לא',
  not_required: 'לא נדרש',
};

export const incidentDomainLabels: Record<IncidentDomain, string> = {
  communications: 'תקשורת',
  equipment: 'ציוד או חומרה',
  software: 'תוכנה',
  infrastructure: 'תשתית או חשמל',
  operational: 'תפעול או הגדרה',
  unknown: 'לא ידוע בשלב זה',
  other: 'אחר',
};

/** Fixed display order, mirrors incident_domain's own declaration order. */
export const INCIDENT_DOMAIN_ORDER: IncidentDomain[] = [
  'communications',
  'equipment',
  'software',
  'infrastructure',
  'operational',
  'unknown',
  'other',
];

/** Shown only when Incident.reportedDomain is `null` -- never used as a
 *  fallback for the explicit 'unknown' enum value, which has its own
 *  label above ("לא ידוע בשלב זה"). */
export const UNCLASSIFIED_DOMAIN_LABEL = 'לא סווג בעת פתיחת התקלה';

export const suspectedCauseLabels: Record<SuspectedCause, string> = {
  equipment: 'ציוד או חומרה',
  software: 'תוכנה',
  communications: 'תקשורת',
  infrastructure: 'תשתית או חשמל',
  operational: 'תפעול או הגדרה',
  external: 'גורם חיצוני',
  unknown: 'הגורם טרם ידוע',
  other: 'אחר',
};

export const SUSPECTED_CAUSE_ORDER: SuspectedCause[] = [
  'equipment',
  'software',
  'communications',
  'infrastructure',
  'operational',
  'external',
  'unknown',
  'other',
];

/** Shown only when Incident.currentSuspectedCause is `null` ("never
 *  assessed") -- never used as a fallback for the explicit 'unknown'
 *  enum value, which has its own label above ("הגורם טרם ידוע"). */
export const UNASSESSED_CAUSE_LABEL = 'לא הוזנה הערכת גורם';

export const treatmentActionTypeLabels: Record<TreatmentActionType, string> = {
  diagnosis: 'בדיקה או אבחון',
  reset_restart: 'אתחול או איפוס',
  equipment_replacement: 'החלפת ציוד',
  config_change: 'שינוי הגדרה',
  software_fix: 'תיקון תוכנה',
  communications_handling: 'טיפול בתקשורת',
  infrastructure_handling: 'טיפול בתשתית או חשמל',
  external_party_handling: 'פנייה או טיפול של גורם חיצוני',
  other: 'אחר',
};

export const TREATMENT_ACTION_TYPE_ORDER: TreatmentActionType[] = [
  'diagnosis',
  'reset_restart',
  'equipment_replacement',
  'config_change',
  'software_fix',
  'communications_handling',
  'infrastructure_handling',
  'external_party_handling',
  'other',
];

export const confirmedCauseLabels: Record<ConfirmedCause, string> = {
  equipment: 'ציוד או חומרה',
  software: 'תוכנה',
  communications: 'תקשורת',
  infrastructure: 'תשתית או חשמל',
  operational: 'תפעול או הגדרה',
  external: 'גורם חיצוני',
  undetermined: 'לא אותר גורם',
  other: 'אחר',
};

export const CONFIRMED_CAUSE_ORDER: ConfirmedCause[] = [
  'equipment',
  'software',
  'communications',
  'infrastructure',
  'operational',
  'external',
  'undetermined',
  'other',
];

export const treatmentOutcomeLabels: Record<TreatmentOutcome, string> = {
  permanent_resolution: 'פתרון קבוע',
  temporary_workaround: 'פתרון זמני או מעקף',
  not_reproduced: 'התקלה לא שוחזרה',
  resolved_without_action: 'התקלה נעלמה ללא פעולה',
  closed_without_technical_resolution: 'נסגרה ללא פתרון טכני',
  other: 'אחר',
};

export const TREATMENT_OUTCOME_ORDER: TreatmentOutcome[] = [
  'permanent_resolution',
  'temporary_workaround',
  'not_reproduced',
  'resolved_without_action',
  'closed_without_technical_resolution',
  'other',
];

export const resolutionAttributionLabels: Record<ResolutionAttribution, string> = {
  specific_action: 'פעולה מסוימת שתועדה',
  combination_of_actions: 'שילוב של מספר פעולות',
  undetermined: 'לא ניתן לקבוע',
  no_action_taken: 'לא בוצעה פעולה',
  external_party_no_details: 'הטיפול בוצע על ידי גורם חיצוני ולא נמסרו פרטים',
  other: 'אחר',
};

export const RESOLUTION_ATTRIBUTION_ORDER: ResolutionAttribution[] = [
  'specific_action',
  'combination_of_actions',
  'undetermined',
  'no_action_taken',
  'external_party_no_details',
  'other',
];

export const eventTypeLabels: Record<EventType, string> = {
  created: 'פתיחת תקלה',
  acknowledged: 'קבלת התקלה',
  update: 'עדכון טיפול',
  status_change: 'שינוי סטטוס',
  severity_change: 'שינוי חומרה',
  impact_change: 'שינוי השפעה מבצעית',
  assignment_change: 'שינוי גורם מטפל',
  deadline_change: 'שינוי צפי עדכון',
  reported_to_ops_change: 'עדכון דיווח למבצעים',
  correction: 'תיקון רישום',
  // Historical only -- written by the now-removed shift-handover feature;
  // kept for read compatibility with hosted databases (see EventType).
  handover_included: 'נכללה בהעברת משמרת',
  handover_accepted: 'העברת משמרת אושרה',
  closed: 'סגירת תקלה',
  follow_up_completed: 'השלמת פעולות המשך',
  reopened: 'פתיחה מחדש',
  cancelled: 'ביטול תקלה',
  severity_assessed: 'הערכת חומרה',
  status_check_changed: 'עדכון בדיקת סטטוס',
  reported_to_ops_room: 'דיווח לחמ״ל',
  reported_to_ops_communications: 'דיווח לתקשוב למבצעים',
  cause_assessment_changed: 'עדכון חשד לגורם',
};

export const notificationTypeLabels: Record<NotificationType, string> = {
  incident_assigned: 'תקלה הוקצתה אליך',
  // Historical only -- no new row of this type is ever written; kept for
  // read compatibility with hosted databases (see NotificationType).
  update_overdue: 'עבר מועד העדכון',
  // Reused for both the personal "reopened and assigned to you" notification
  // and the generic professional-manager broadcast -- category (below)
  // disambiguates which one a given row is.
  incident_reopened: 'תקלה נפתחה מחדש',
  // Historical only -- written by the now-removed shift-handover feature;
  // kept for read compatibility with hosted databases (see NotificationType).
  handover_pending: 'העברת משמרת ממתינה לאישורך',
  incident_opened: 'תקלה נפתחה',
  incident_updated: 'עדכון תקלה',
  incident_closed: 'תקלה נסגרה',
  incident_cancelled: 'תקלה בוטלה',
};

/** Bell notification-center filters: 'all' plus the two durable categories. */
export type NotificationFilter = 'all' | NotificationCategory;

export const notificationFilterLabels: Record<NotificationFilter, string> = {
  all: 'הכול',
  action_required: 'דורש פעולה',
  update: 'עדכונים',
};

/** Fixed display order for system categories -- product-defined, not
 *  administratively configurable. Every place that groups systems by
 *  category (management page, incident-creation selector) iterates this
 *  array so the section order can never drift between call sites. */
export const SYSTEM_CATEGORY_ORDER: SystemCategory[] = [
  'platforms',
  'station_systems',
  'computing',
  'infrastructure',
  'other',
];

export const systemCategoryLabels: Record<SystemCategory, string> = {
  platforms: 'פלטפורמות',
  station_systems: 'מערכות תחנה',
  computing: 'מחשוב',
  infrastructure: 'תשתיות',
  other: 'אחר',
};

/** Fixed display order for location categories -- see SYSTEM_CATEGORY_ORDER. */
export const LOCATION_CATEGORY_ORDER: LocationCategory[] = [
  'unit_internal',
  'field_side',
  'external_bases',
  'external_sites',
  'other',
];

export const locationCategoryLabels: Record<LocationCategory, string> = {
  unit_internal: 'פנים יחידתי',
  field_side: 'צד שטח',
  external_bases: 'בסיסים חיצוניים',
  external_sites: 'אתרים חיצוניים',
  other: 'אחר',
};

/** Hebrew labels for audit_logs.action -- the primary user-facing text on
 *  the יומן ביקורת (audit log) page. Raw action identifiers are never
 *  shown directly; an unrecognized action falls back to the identifier
 *  itself (see AuditLogPage) rather than failing to render. */
export const auditActionLabels: Record<string, string> = {
  // Personnel
  user_role_changed: 'שינוי תפקיד',
  user_activated: 'הפעלת משתמש',
  user_deactivated: 'השבתת משתמש',
  user_tombstoned: 'מחיקת משתמש',
  user_renamed: 'שינוי שם משתמש',
  user_created: 'הזמנת משתמש',
  personnel_pending_created: 'הזמנת איש צוות',
  personnel_pending_updated: 'עדכון הזמנת איש צוות',
  personnel_pending_renamed: 'שינוי שם בהזמנה ממתינה',
  personnel_pending_cancelled: 'ביטול הזמנת איש צוות',
  personnel_pending_claimed: 'מימוש הזמנת איש צוות',
  personnel_pending_expired: 'פקיעת הזמנת איש צוות',
  // Systems / locations
  system_created: 'הוספת מערכת / עמדה',
  system_renamed: 'שינוי שם מערכת / עמדה',
  system_archived: 'השבתת מערכת / עמדה',
  system_restored: 'הפעלת מערכת / עמדה',
  system_category_changed: 'שינוי סוג מערכת / עמדה',
  system_moved: 'שינוי סדר מערכת / עמדה',
  systems_reordered: 'סידור מחדש של מערכות / עמדות',
  system_delete_archived: 'בקשת מחיקת מערכת / עמדה (הועברה למצב לא פעיל)',
  system_deleted: 'מחיקת מערכת / עמדה',
  location_created: 'הוספת מיקום',
  location_renamed: 'שינוי שם מיקום',
  location_archived: 'השבתת מיקום',
  location_restored: 'הפעלת מיקום',
  location_category_changed: 'שינוי סוג מיקום',
  location_moved: 'שינוי סדר מיקום',
  locations_reordered: 'סידור מחדש של מיקומים',
  location_delete_archived: 'בקשת מחיקת מיקום (הועבר למצב לא פעיל)',
  location_deleted: 'מחיקת מיקום',
  // Incidents
  incident_created: 'פתיחת תקלה',
  incident_updated: 'עדכון תקלה',
  incident_status_changed: 'שינוי סטטוס תקלה',
  incident_severity_changed: 'שינוי חומרת תקלה',
  incident_assigned: 'שינוי גורם מטפל',
  incident_external_handler_changed: 'שינוי גורם מטפל חיצוני',
  incident_acknowledged: 'קבלת תקלה',
  incident_technical_update: 'עדכון טכני לתקלה',
  incident_closed: 'סגירת תקלה',
  incident_partial_readiness: 'סגירה עם כשירות חלקית',
  incident_reopened: 'פתיחה מחדש של תקלה',
  incident_cancelled: 'ביטול תקלה',
  incident_correction: 'תיקון רישום בתקלה',
  incident_follow_up_completed: 'השלמת פעולות המשך',
  // Handovers -- historical only, written by the now-removed shift-handover
  // feature; kept for read compatibility with the audit log (free-text
  // action column, never validated against a fixed enum).
  handover_created: 'יצירת העברת משמרת',
  handover_accepted: 'אישור העברת משמרת',
  handover_addendum: 'תוספת להעברת משמרת',
  // Export
  export_generated: 'ייצוא נתונים',
};

/** Hebrew labels for audit_logs.entity_type. */
export const auditEntityTypeLabels: Record<string, string> = {
  profile: 'משתמש',
  pending_personnel: 'הזמנת איש צוות',
  system: 'מערכת / עמדה',
  location: 'מיקום',
  incident: 'תקלה',
  // Historical only -- see auditActionLabels' Handovers comment above.
  handover: 'העברת משמרת',
  export: 'ייצוא',
};

export const fieldLabels: Record<string, string> = {
  status: 'סטטוס',
  severity: 'חומרה',
  operational_impact: 'השפעה מבצעית',
  owner: 'גורם מטפל',
  external_handler: 'גורם מטפל חיצוני',
  // next_update_due/no_deadline_reason: the next-update-ETA concept was
  // removed from creation/update/reopen (no longer an active question the
  // product asks), but these labels stay -- historical deadline_change
  // timeline events from before the removal still render through them.
  next_update_due: 'צפי לעדכון הבא',
  reported_to_ops: 'דווח למבצעים',
  reported_to_ops_recipient: 'למי דווח',
  current_status_text: 'סטטוס נוכחי',
  current_suspected_cause: 'חשד נוכחי',
};
