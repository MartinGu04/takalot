// Translates the raw incident timeline (IncidentEvent/IncidentUpdate rows --
// database field names, enum values, booleans) into plain, human-readable
// Hebrew blocks for the PDF export. Never renders a raw field name, enum
// value, boolean, or before/after object; an event type this module does
// not recognize falls back to a safe generic title and never dumps
// metadata. Reuses the same event grouping the on-screen Timeline component
// uses (domain/timelineGrouping.ts) so one operation still renders as one
// block here, consistent with the UI.
import type { EventType, IncidentEvent, IncidentUpdate, Profile, Readiness } from '../domain/types';
import { groupTimelineEvents } from '../domain/timelineGrouping';
import {
  eventTypeLabels,
  fieldLabels,
  readinessLabels,
  reportedToOpsLabels,
  severityLabels,
  statusLabels,
} from '../domain/labels';
import { formatDateTime } from '../lib/time';
import { isolate } from './bidi';

export interface TimelineBlock {
  eventTime: string;
  title: string;
  performer: string;
  /** Emphasis tier for the block's visual treatment -- mirrors the on-screen
   *  Timeline's tiering so the PDF and the app agree on what stands out. */
  tier: 'strong' | 'neutral';
  /** Plain Hebrew detail lines, already isolate()-wrapped wherever they
   *  embed a dynamic non-Hebrew-guaranteed value. Never a raw field name,
   *  enum value, or boolean. */
  details: string[];
}

const LIFECYCLE_TYPES = new Set<EventType>(['created', 'closed', 'reopened', 'cancelled']);

function actorName(id: string | null, label: string | null, profiles: Profile[]): string {
  if (label) return label;
  if (!id) return 'המערכת';
  return profiles.find((p) => p.id === id)?.fullName ?? 'משתמש';
}

function statusValue(value: string | null): string {
  if (!value) return '—';
  if (value in statusLabels) return statusLabels[value as keyof typeof statusLabels];
  if (value in reportedToOpsLabels) return reportedToOpsLabels[value as keyof typeof reportedToOpsLabels];
  return value;
}

/** One field-change event ("X שונה: לפני ← אחרי"), translated through the
 *  same known label tables the on-screen Timeline uses -- never the raw
 *  stored value. */
function fieldChangeTitle(event: IncidentEvent): string | null {
  if (!event.field) return null;
  switch (event.field) {
    case 'status':
      return `סטטוס שונה: ${isolate(statusValue(event.oldValue))} ← ${isolate(statusValue(event.newValue))}`;
    case 'severity': {
      const oldLabel = event.oldValue && event.oldValue in severityLabels
        ? severityLabels[event.oldValue as keyof typeof severityLabels]
        : (event.oldValue ?? '—');
      const newLabel = event.newValue && event.newValue in severityLabels
        ? severityLabels[event.newValue as keyof typeof severityLabels]
        : (event.newValue ?? '—');
      return `החומרה שונתה: ${isolate(oldLabel)} ← ${isolate(newLabel)}`;
    }
    case 'owner':
      return event.newValue
        ? `בעל האחריות הפנימי שונה ל${isolate(event.newValue)}`
        : 'בעל האחריות הפנימי הוסר';
    case 'external_handler':
      return event.newValue
        ? `הגורם המטפל החיצוני שונה ל${isolate(event.newValue)}`
        : 'הגורם המטפל החיצוני הוסר';
    case 'operational_impact':
      return 'ההשפעה המבצעית עודכנה';
    case 'next_update_due':
      return event.newValue
        ? `צפי לעדכון הבא עודכן ל${isolate(formatDateTime(event.newValue))}`
        : 'צפי לעדכון הבא הוסר';
    default:
      return `${fieldLabels[event.field] ?? 'פרט'} עודכן`;
  }
}

/** reported_to_ops_change carries only the recipient in old/new_value (see
 *  domain/timelineGrouping.ts's header comment) -- the yes/no/not_required
 *  status itself is never exposed here as a raw enum, only through these
 *  two fixed, human phrasings. */
function reportedToOpsChangeTitle(event: IncidentEvent): string {
  return event.newValue
    ? `הנמען לדיווח למבצעים עודכן ל${isolate(event.newValue)}`
    : 'הדיווח למבצעים בוטל';
}

function statusCheckTitle(event: IncidentEvent): string {
  return event.newValue
    ? `נקבעה בדיקת סטטוס הבאה ל${isolate(formatDateTime(event.newValue))}`
    : 'בדיקת סטטוס הושלמה';
}

function severityAssessedTitle(event: IncidentEvent): string {
  const label = event.newValue && event.newValue in severityLabels
    ? severityLabels[event.newValue as keyof typeof severityLabels]
    : (event.newValue ?? '—');
  return `הוערכה חומרת התקלה: ${isolate(label)}`;
}

function reportedToOpsRoomOrCommsTitle(event: IncidentEvent): string {
  const label = event.newValue && event.newValue in reportedToOpsLabels
    ? reportedToOpsLabels[event.newValue as keyof typeof reportedToOpsLabels]
    : (event.newValue ?? '—');
  return `${eventTypeLabels[event.type]}: ${isolate(label)}`;
}

/** The block's headline sentence for a single event, in plain Hebrew --
 *  never the event's raw type/field/value. Falls back to a safe generic
 *  title for any event type this function does not explicitly recognize
 *  (forward-compatibility: a future event type the PDF hasn't been taught
 *  about yet must never leak raw data). */
export function narrativeTitle(event: IncidentEvent): string {
  switch (event.type) {
    case 'created':
      return 'התקלה נפתחה';
    case 'acknowledged':
      return 'התקלה התקבלה לטיפול';
    case 'update':
      return 'עדכון טיפול';
    case 'status_change':
    case 'severity_change':
    case 'impact_change':
    case 'assignment_change':
    case 'deadline_change':
      return fieldChangeTitle(event) ?? 'אירוע מערכת';
    case 'reported_to_ops_change':
      return reportedToOpsChangeTitle(event);
    case 'correction':
      return 'בוצע תיקון רישום';
    case 'handover_included':
      return 'נכללה בהעברת משמרת';
    case 'handover_accepted':
      return 'העברת משמרת אושרה';
    case 'closed':
      return 'התקלה נסגרה';
    case 'follow_up_completed':
      return 'פעולות ההמשך הושלמו';
    case 'reopened':
      return 'התקלה נפתחה מחדש';
    case 'cancelled':
      return 'התקלה בוטלה';
    case 'severity_assessed':
      return severityAssessedTitle(event);
    case 'status_check_changed':
      return statusCheckTitle(event);
    case 'reported_to_ops_room':
    case 'reported_to_ops_communications':
      return reportedToOpsRoomOrCommsTitle(event);
    default:
      // Unrecognized event type (e.g. a future addition the PDF export
      // hasn't been taught about yet): a safe generic title, never a raw
      // type/field/value dump.
      return 'אירוע מערכת';
  }
}

/** Free-text notes are already authored, human Hebrew (change reasons,
 *  cancellation reasons, correction explanations, creation summaries) --
 *  safe to show verbatim, split into per-line detail entries. Never used
 *  for reported_to_ops_change, whose note duplicates the recipient fact
 *  reportedToOpsChangeTitle already states. */
function noteDetails(event: IncidentEvent): string[] {
  if (!event.note || event.type === 'reported_to_ops_change') return [];
  return event.note.split('\n').filter(Boolean);
}

function updateDetails(update: IncidentUpdate): string[] {
  const lines: string[] = [];
  if (update.currentStatusText) lines.push(`${fieldLabels.current_status_text}: ${update.currentStatusText}`);
  lines.push(`פעולות שבוצעו: ${update.actionsTaken}`);
  if (update.findings) lines.push(`ממצאים: ${update.findings}`);
  if (update.nextSteps) lines.push(`פעולות המשך: ${update.nextSteps}`);
  if (update.updateReportedToOps != null) {
    const recipient =
      update.updateReportedToOps === 'yes' && update.updateReportedToOpsRecipient
        ? ` (${isolate(update.updateReportedToOpsRecipient)})`
        : '';
    lines.push(`דווח למבצעים בעדכון זה: ${reportedToOpsLabels[update.updateReportedToOps]}${recipient}`);
  }
  if (update.updateReportedToComms != null) {
    const recipient =
      update.updateReportedToComms && update.updateReportedToCommsRecipient
        ? ` (${isolate(update.updateReportedToCommsRecipient)})`
        : '';
    lines.push(`דווח לתקשוב למבצעים בעדכון זה: ${update.updateReportedToComms ? 'כן' : 'לא'}${recipient}`);
  }
  if (update.updateWisdomReported != null) {
    lines.push(`עודכן ב-WISDOM בעדכון זה: ${update.updateWisdomReported ? 'כן' : 'לא'}`);
  }
  return lines;
}

/** Every additional detail line for one primary event: its own note (a
 *  human-authored free-text fact), the linked update's structured fields
 *  when this is an 'update' event, and a closure-readiness line for
 *  'closed'. Never a raw field/oldValue/newValue dump. */
function primaryDetails(event: IncidentEvent, update: IncidentUpdate | undefined): string[] {
  const details = [...noteDetails(event)];
  if (update) details.push(...updateDetails(update));
  if (event.type === 'closed' && event.newValue && event.newValue in readinessLabels) {
    details.push(`כשירות בסגירה: ${readinessLabels[event.newValue as Readiness]}`);
  }
  return details;
}

/** A subordinate change from the same operation, rendered as one compact
 *  detail line reusing the same narrative-title mapping as the primary
 *  event -- never a raw field diff. */
function subordinateDetail(event: IncidentEvent): string {
  const title = narrativeTitle(event);
  const note = event.type !== 'reported_to_ops_change' ? event.note : null;
  return note ? `${title} (${note})` : title;
}

export function buildTimelineBlocks(
  events: IncidentEvent[],
  updates: IncidentUpdate[],
  profiles: Profile[],
): TimelineBlock[] {
  const updatesById = new Map(updates.map((u) => [u.id, u]));
  const groups = groupTimelineEvents(events);

  return groups.map(({ primary, subordinates }) => {
    const update = primary.refId ? updatesById.get(primary.refId) : undefined;
    const details = primaryDetails(primary, update);
    for (const subordinate of subordinates) {
      details.push(subordinateDetail(subordinate));
    }
    return {
      eventTime: primary.eventTime,
      title: narrativeTitle(primary),
      performer: actorName(primary.actorId, primary.actorLabel, profiles),
      tier: LIFECYCLE_TYPES.has(primary.type) ? 'strong' : 'neutral',
      details,
    };
  });
}
