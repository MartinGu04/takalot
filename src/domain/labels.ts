// Hebrew labels for all fixed enums. UI text lives here; code identifiers stay English.
import type {
  Role,
  Severity,
  IncidentStatus,
  Readiness,
  ReportedToOps,
  EventType,
  NotificationType,
  SystemCategory,
  LocationCategory,
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
};

export const notificationTypeLabels: Record<NotificationType, string> = {
  incident_assigned: 'תקלה הוקצתה אליך',
  // Historical only -- no new row of this type is ever written; kept for
  // read compatibility with hosted databases (see NotificationType).
  update_overdue: 'עבר מועד העדכון',
  incident_reopened: 'תקלה נפתחה מחדש',
  handover_pending: 'העברת משמרת ממתינה לאישורך',
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
};
