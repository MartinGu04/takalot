// Translates the raw incident timeline (IncidentEvent/IncidentUpdate rows --
// database field names, enum values, booleans) into plain, human-readable
// Hebrew blocks for the PDF export. Never renders a raw field name, enum
// value, boolean, or before/after object; an event type this module does
// not recognize falls back to a safe generic title and never dumps
// metadata. Reuses the same event grouping the on-screen Timeline component
// uses (domain/timelineGrouping.ts) so one operation still renders as one
// block here, consistent with the UI.
import type {
  EventType,
  IncidentCauseAssessment,
  IncidentClosureClassification,
  IncidentEvent,
  IncidentTreatmentAction,
  IncidentUpdate,
  Profile,
  Readiness,
  SuspectedCause,
} from '../domain/types';
import { groupTimelineEvents } from '../domain/timelineGrouping';
import {
  confirmedCauseLabels,
  eventTypeLabels,
  fieldLabels,
  readinessLabels,
  reportedToOpsLabels,
  resolutionAttributionLabels,
  severityLabels,
  statusLabels,
  suspectedCauseLabels,
  treatmentActionTypeLabels,
  treatmentOutcomeLabels,
  UNASSESSED_CAUSE_LABEL,
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

/** A free-text detail suffix (" — <detail>"), isolated since the detail is
 *  user-authored text of unknown script/direction -- never rendered for a
 *  non-'other' value. Shared by every classification value formatter below,
 *  and reused as-is by incidentPdf.ts's main-summary fields so the exact
 *  same detail-suffix rule applies everywhere a classification value is
 *  shown. */
function otherDetailSuffix(detail: string | null): string {
  return detail ? ` — ${isolate(detail)}` : '';
}

/** The suspected-cause value to display -- `null` ("never assessed") and
 *  the explicit `'unknown'` enum member ("assessed as not yet known") are
 *  never conflated; each keeps its own distinct approved label. Shared by
 *  the initial-cause / cause-change timeline lines and by incidentPdf.ts's
 *  main-summary "חשד נוכחי" field. */
export function suspectedCauseValue(cause: SuspectedCause | null, otherDetail: string | null = null): string {
  if (!cause) return UNASSESSED_CAUSE_LABEL;
  return `${suspectedCauseLabels[cause]}${cause === 'other' ? otherDetailSuffix(otherDetail) : ''}`;
}

/** One structured treatment action's display label, 'other' included. */
export function treatmentActionValue(action: IncidentTreatmentAction): string {
  return `${treatmentActionTypeLabels[action.actionType]}${action.actionType === 'other' ? otherDetailSuffix(action.otherDetail) : ''}`;
}

/** A comma-joined list of treatment-action labels -- used for both the
 *  creation-time and update-time compact "actions" lines. */
export function treatmentActionListValue(actions: IncidentTreatmentAction[]): string {
  return actions.map(treatmentActionValue).join(', ');
}

/** One closure's confirmed-cause value -- shared by the closure timeline
 *  block and incidentPdf.ts's main closure-summary field. */
export function confirmedCauseValue(closure: IncidentClosureClassification): string {
  return `${confirmedCauseLabels[closure.confirmedCause]}${closure.confirmedCause === 'other' ? otherDetailSuffix(closure.confirmedCauseOtherDetail) : ''}`;
}

/** One closure's treatment-outcome value. */
export function treatmentOutcomeValue(closure: IncidentClosureClassification): string {
  return `${treatmentOutcomeLabels[closure.treatmentOutcome]}${closure.treatmentOutcome === 'other' ? otherDetailSuffix(closure.treatmentOutcomeOtherDetail) : ''}`;
}

/** One closure's resolution-attribution value, with its linked resolving
 *  action(s) appended (e.g. "פעולה מסוימת שתועדה: החלפת ציוד") only when
 *  the attribution is one that ever links actions at all
 *  (specific_action/combination_of_actions) and at least one of the linked
 *  ids actually resolves against the incident's own treatment-action rows. */
export function resolutionAttributionValue(
  closure: IncidentClosureClassification,
  treatmentActions: IncidentTreatmentAction[],
): string {
  const base = `${resolutionAttributionLabels[closure.resolutionAttribution]}${closure.resolutionAttribution === 'other' ? otherDetailSuffix(closure.resolutionAttributionOtherDetail) : ''}`;
  if (closure.resolutionAttribution !== 'specific_action' && closure.resolutionAttribution !== 'combination_of_actions') {
    return base;
  }
  const linked = closure.resolutionActionIds
    .map((id) => treatmentActions.find((a) => a.id === id))
    .filter((a): a is IncidentTreatmentAction => !!a);
  return linked.length > 0 ? `${base}: ${treatmentActionListValue(linked)}` : base;
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
    case 'current_suspected_cause': {
      // The RPC/demo repo write '' (coalesced), not null, for "no prior
      // cause" -- both fold to the same UNASSESSED_CAUSE_LABEL fallback
      // here, matching the on-screen Timeline's own valueLabel() handling.
      const oldValue = (event.oldValue as SuspectedCause | '' | null) || null;
      const newValue = (event.newValue as SuspectedCause | '' | null) || null;
      return `חשד נוכחי שונה: ${isolate(suspectedCauseValue(oldValue))} ← ${isolate(suspectedCauseValue(newValue))}`;
    }
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
    case 'cause_assessment_changed':
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
 *  when this is an 'update' event, a closure-readiness line for 'closed',
 *  plus (when supplied) the structured lifecycle-classification lines that
 *  belong to THIS exact event -- the initial suspected cause/treatment
 *  actions on 'created' (never a fabricated action time -- see the wording
 *  below), the treatment actions recorded during an 'update', and the
 *  confirmed-cause/treatment-outcome/resolution-attribution belonging to
 *  this specific closure cycle on 'closed'. Never a raw field/oldValue/
 *  newValue dump, and never the SAME classification value repeated twice
 *  within these lines (the closure block below is the only place a
 *  closure's structured fields appear in this function's output). */
function primaryDetails(
  event: IncidentEvent,
  update: IncidentUpdate | undefined,
  initialCause: IncidentCauseAssessment | undefined,
  groupTreatmentActions: IncidentTreatmentAction[],
  closure: IncidentClosureClassification | undefined,
  allTreatmentActions: IncidentTreatmentAction[],
): string[] {
  const details = [...noteDetails(event)];
  if (update) details.push(...updateDetails(update));
  if (event.type === 'closed' && event.newValue && event.newValue in readinessLabels) {
    details.push(`כשירות בסגירה: ${readinessLabels[event.newValue as Readiness]}`);
  }
  if (event.type === 'created') {
    if (initialCause) {
      details.push(
        `חשד ראשוני: ${suspectedCauseValue(initialCause.cause, initialCause.otherDetail)} — תועד בעת פתיחת התקלה`,
      );
    }
    if (groupTreatmentActions.length > 0) {
      details.push(`פעולות שסווגו בעת הפתיחה: ${treatmentActionListValue(groupTreatmentActions)}`);
    }
  }
  if (event.type === 'update' && groupTreatmentActions.length > 0) {
    details.push(`פעולות טיפול: ${treatmentActionListValue(groupTreatmentActions)}`);
  }
  if (event.type === 'closed' && closure) {
    details.push(`הגורם שאומת: ${confirmedCauseValue(closure)}`);
    details.push(`תוצאת הטיפול: ${treatmentOutcomeValue(closure)}`);
    details.push(`מה ידוע על מה שהוביל לפתרון: ${resolutionAttributionValue(closure, allTreatmentActions)}`);
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

/**
 * Structured lifecycle-classification data is entirely optional (defaults
 * to empty) so every existing caller/test that only ever passed
 * events/updates/profiles keeps working, unchanged, for an incident that
 * has none of it -- a legacy incident's PDF timeline must render exactly
 * as it always has. Joined onto the relevant primary event by operationId
 * (causeAssessments/treatmentActions) or by refId (closures), mirroring
 * exactly how the on-screen Timeline component joins the same data --
 * never rendered as separate timeline blocks of their own.
 */
export function buildTimelineBlocks(
  events: IncidentEvent[],
  updates: IncidentUpdate[],
  profiles: Profile[],
  causeAssessments: IncidentCauseAssessment[] = [],
  treatmentActions: IncidentTreatmentAction[] = [],
  closures: IncidentClosureClassification[] = [],
): TimelineBlock[] {
  const updatesById = new Map(updates.map((u) => [u.id, u]));
  const closuresById = new Map(closures.map((c) => [c.id, c]));
  const treatmentActionsByOperation = new Map<string, IncidentTreatmentAction[]>();
  for (const a of treatmentActions) {
    if (!a.operationId) continue;
    const list = treatmentActionsByOperation.get(a.operationId) ?? [];
    list.push(a);
    treatmentActionsByOperation.set(a.operationId, list);
  }
  const initialCauseByOperation = new Map<string, IncidentCauseAssessment>();
  for (const c of causeAssessments) {
    // Only the initial, creation-time assessment (no known effective time)
    // is rendered inline this way -- every later change already gets its
    // own explicit cause_assessment_changed subordinate line above.
    if (c.operationId && c.eventTime === null) initialCauseByOperation.set(c.operationId, c);
  }
  const groups = groupTimelineEvents(events);

  return groups.map(({ primary, subordinates, operationId }) => {
    const update = primary.refId ? updatesById.get(primary.refId) : undefined;
    const groupTreatmentActions = operationId ? treatmentActionsByOperation.get(operationId) ?? [] : [];
    const initialCause = operationId ? initialCauseByOperation.get(operationId) : undefined;
    const closure = primary.type === 'closed' && primary.refId ? closuresById.get(primary.refId) : undefined;
    const details = primaryDetails(primary, update, initialCause, groupTreatmentActions, closure, treatmentActions);
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
