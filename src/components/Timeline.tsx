// Compact, scannable incident timeline. One user operation (one shared,
// non-null operationId) renders as one grouped item, dated once per
// calendar day; a primary event is chosen for the item (see
// domain/timelineGrouping.ts) and every other row from that operation
// renders as a compact inline change beside it -- never as its own
// marker/time/actor, so one operation always reads as one visual event.
// Lifecycle events, treatment updates and corrections get a richer,
// multi-line card (with verbose content behind "פרטים נוספים"); every
// other event type (a single field delta) renders as one compact row.
// Readable on mobile; does not rely on color, arrows, or strikethrough
// alone -- every value is also present as visible or screen-reader text.
import { useId, useState, type ComponentType, type ReactNode, type SVGProps } from 'react';
import type {
  EventType,
  IncidentCauseAssessment,
  IncidentClosureClassification,
  IncidentEvent,
  IncidentTreatmentAction,
  IncidentUpdate,
  Profile,
} from '../domain/types';
import { groupTimelineEvents, groupByCalendarDate, type TimelineGroup } from '../domain/timelineGrouping';
import { timelineVisualKind, isRichTimelineEvent, type TimelineVisualKind } from '../domain/timelineEventKind';
import {
  eventTypeLabels,
  fieldLabels,
  severityLabels,
  statusLabels,
  readinessLabels,
  reportedToOpsLabels,
  suspectedCauseLabels,
  confirmedCauseLabels,
  treatmentOutcomeLabels,
  resolutionAttributionLabels,
  treatmentActionTypeLabels,
  UNASSESSED_CAUSE_LABEL,
} from '../domain/labels';
import { formatDateTime, formatDuration, formatDate, formatTime } from '../lib/time';
import { Avatar } from './ui';
import {
  IconPlus,
  IconEye,
  IconWrench,
  IconArrowsExchange,
  IconAlertTriangle,
  IconUsers,
  IconClock,
  IconHeadset,
  IconSettings,
  IconCheck,
  IconRotateCcw,
  IconTrash,
  IconClipboardList,
  IconFlag,
  IconChevronLeft,
  IconChevronDown,
} from './icons';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

function valueLabel(field: string | null, value: string | null): string {
  if (value == null) return '—';
  // reported_to_ops_room/reported_to_ops_communications events also use
  // field: 'status', but carry a ReportedToOps value (yes/no/not_required),
  // not an IncidentStatus -- the two value sets never overlap, so trying
  // reportedToOpsLabels first is safe and unambiguous.
  if (field === 'status' && value in reportedToOpsLabels) {
    return reportedToOpsLabels[value as keyof typeof reportedToOpsLabels];
  }
  if (field === 'status' && value in statusLabels) {
    return statusLabels[value as keyof typeof statusLabels];
  }
  if (field === 'severity' && value in severityLabels) {
    return severityLabels[value as keyof typeof severityLabels];
  }
  if (field === 'current_suspected_cause') {
    if (!value) return UNASSESSED_CAUSE_LABEL;
    return value in suspectedCauseLabels ? suspectedCauseLabels[value as keyof typeof suspectedCauseLabels] : value;
  }
  if (field === 'next_update_due') return value === 'null' || !value ? 'ללא צפי' : formatDateTime(value);
  if (field === 'status_check_due') return value === 'null' || !value ? 'ללא' : formatDateTime(value);
  return value;
}

/** One icon per EventType, reusing the app's existing hand-rolled icon set
 *  (src/components/icons.tsx) -- no new icon dependency. Several minor
 *  delta types deliberately share an icon: they're always rendered in the
 *  same neutral color (see timelineEventKind.ts), so the shape alone is a
 *  light hint, not the primary distinguishing signal. */
const typeIconComponent: Record<EventType, Icon> = {
  created: IconPlus,
  acknowledged: IconEye,
  update: IconWrench,
  status_change: IconArrowsExchange,
  severity_change: IconAlertTriangle,
  impact_change: IconAlertTriangle,
  assignment_change: IconUsers,
  deadline_change: IconClock,
  reported_to_ops_change: IconHeadset,
  correction: IconSettings,
  handover_included: IconUsers,
  handover_accepted: IconUsers,
  closed: IconCheck,
  follow_up_completed: IconCheck,
  reopened: IconRotateCcw,
  cancelled: IconTrash,
  severity_assessed: IconAlertTriangle,
  status_check_changed: IconClipboardList,
  reported_to_ops_room: IconHeadset,
  reported_to_ops_communications: IconHeadset,
  cause_assessment_changed: IconFlag,
};

/** Solid, saturated marker used for rich (card) entries -- bold enough to
 *  anchor the eye scanning down the line. Muted marker used for compact
 *  rows -- present, but deliberately quieter than a rich entry's. Both
 *  reuse only colors already in the app's muted-accent convention (see
 *  ui.tsx Badge); 'open' reuses the existing brand color, already violet
 *  (see index.css), rather than inventing a new purple. */
const solidMarkerClasses: Record<TimelineVisualKind, string> = {
  open: 'bg-brand-600 text-white dark:bg-brand-500',
  update: 'bg-blue-600 text-white dark:bg-blue-500',
  status: 'bg-yellow-500 text-white dark:bg-yellow-500',
  report: 'bg-orange-600 text-white dark:bg-orange-500',
  closed: 'bg-green-600 text-white dark:bg-green-500',
  reopened: 'bg-red-600 text-white dark:bg-red-500',
  cancelled: 'bg-surface-active text-text-secondary border border-hairline-strong',
  neutral: 'bg-surface-active text-text-secondary border border-hairline-strong',
};

const mutedMarkerClasses: Record<TimelineVisualKind, string> = {
  open: 'bg-brand-100 text-brand-800 border border-brand-300 dark:bg-brand-950 dark:text-brand-200 dark:border-brand-800',
  update: 'bg-blue-100 text-blue-900 border border-blue-300 dark:bg-blue-950 dark:text-blue-200 dark:border-blue-800',
  status:
    'bg-yellow-100 text-yellow-900 border border-yellow-300 dark:bg-yellow-950 dark:text-yellow-200 dark:border-yellow-800',
  report:
    'bg-orange-100 text-orange-900 border border-orange-300 dark:bg-orange-950 dark:text-orange-200 dark:border-orange-800',
  closed: 'bg-green-100 text-green-900 border border-green-300 dark:bg-green-950 dark:text-green-200 dark:border-green-800',
  reopened: 'bg-red-100 text-red-900 border border-red-300 dark:bg-red-950 dark:text-red-200 dark:border-red-800',
  cancelled: 'bg-surface-active text-text-secondary border border-hairline',
  neutral: 'bg-surface-active text-text-secondary border border-hairline',
};

/** Compact inline chip list of structured treatment actions sharing one
 *  operationId -- rendered within/beside the update (or creation) card that
 *  recorded them, never as a separate timeline event. */
function TreatmentActionChips({ actions }: { actions: IncidentTreatmentAction[] }) {
  if (actions.length === 0) return null;
  return (
    <div className="mt-1.5">
      <p className="text-xs font-medium text-secondary">פעולות טיפול שנרשמו:</p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {actions.map((a) => (
          <li
            key={a.id}
            className="rounded-md border border-hairline bg-surface px-2 py-0.5 text-xs text-text-primary"
          >
            {treatmentActionTypeLabels[a.actionType]}
            {a.actionType === 'other' && a.otherDetail ? ` — ${a.otherDetail}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

const CORRECTABLE_TYPES = new Set(['update', 'status_change', 'severity_change', 'impact_change', 'assignment_change']);

/**
 * A correction's own `refId` targets whichever id the original record was
 * addressed by at correction time (see CorrectionAction below): for a
 * `type: 'update'` original that's its backing IncidentUpdate.id, for every
 * other correctable type it's the event's own id. Resolving "what does this
 * correction refer to" -- and, in reverse, "does this original have a later
 * correction" -- both need that same two-id rule; getting it wrong (e.g.
 * matching only against event ids) silently misses every correction of an
 * update, the most common case.
 */
function resolveCorrectionTarget(
  refId: string,
  events: IncidentEvent[],
  updatesById: Map<string, IncidentUpdate>,
): { update: IncidentUpdate; event?: undefined } | { update?: undefined; event: IncidentEvent } | undefined {
  const update = updatesById.get(refId);
  if (update) return { update };
  const event = events.find((e) => e.id === refId);
  if (event) return { event };
  return undefined;
}

function correctionsTargeting(events: IncidentEvent[], original: IncidentEvent): IncidentEvent[] {
  const targetId = original.type === 'update' ? original.refId : original.id;
  if (!targetId) return [];
  return events.filter((e) => e.type === 'correction' && e.refId === targetId);
}

/**
 * close_incident's partial-readiness branch: the incident does NOT close --
 * it stays active, status moves to partial_readiness, follow-up stays
 * outstanding. Still a significant operation despite being a plain
 * status_change under the hood, so it's promoted to a rich card with its
 * own banner instead of rendering as a one-line compact row.
 */
function isPartialReadinessAttempt(event: IncidentEvent): boolean {
  return event.type === 'status_change' && event.field === 'status' && event.newValue === 'partial_readiness';
}

function actorDisplayName(id: string | null, label: string | null, profiles: Profile[] | undefined): string {
  return label ?? (id ? (profiles?.find((p) => p.id === id)?.fullName ?? 'משתמש') : 'המערכת');
}

/**
 * One field's before/after as a single compact line, always with the
 * values spelled out (never conveyed by arrow direction or color alone --
 * the arrow icon is aria-hidden and both values are duplicated as
 * screen-reader-only "לפני"/"אחרי" text). Used for every field-level delta,
 * both a compact top-level row and a subordinate nested inside a rich
 * card's content -- one rendering, two placements.
 */
function TransitionPills({ before, after }: { before: string; after: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      <span className="sr-only">לפני: </span>
      <span className="rounded-md bg-surface-active px-1.5 py-0.5 text-text-secondary">{before}</span>
      <IconChevronLeft aria-hidden className="size-3 shrink-0 text-muted" />
      <span className="sr-only">אחרי: </span>
      <span className="rounded-md bg-surface-active px-1.5 py-0.5 font-semibold text-text-primary">{after}</span>
    </span>
  );
}

/**
 * reported_to_ops_change is a special case: old_value/new_value only ever
 * carry the recipient text, while the row's own note carries the fuller
 * "status (recipient)" fact (e.g. "דווח למבצעים: כן (יוסי)"). Rendering the
 * generic field diff AND the note would repeat the recipient and still
 * miss the status on the "after" side, so this renders once: "לפני" = the
 * previous recipient (all that's available) when one exists, "אחרי" = the
 * note (the richer, complete fact) -- no separate note paragraph follows
 * it, here or at the call site.
 *
 * Deliberately never renders event.note for any other type here: a
 * subordinate/compact primary's own note (changeReason etc.) is rendered
 * separately by SubordinateNote right below this, so one place decides
 * whether a note is shown, not two.
 */
function CompactChange({ event }: { event: IncidentEvent }) {
  if (event.type === 'reported_to_ops_change') {
    return (
      <p className="text-xs leading-5">
        <span className="font-medium text-secondary">{fieldLabels.reported_to_ops}: </span>
        {event.oldValue ? (
          <TransitionPills before={event.oldValue} after={event.note ?? '—'} />
        ) : (
          <span className="font-semibold text-text-primary">{event.note ?? '—'}</span>
        )}
      </p>
    );
  }
  if (!event.field) return null;
  const label = fieldLabels[event.field] ?? event.field;
  const after = valueLabel(event.field, event.newValue);
  return (
    <p className="text-xs leading-5">
      <span className="font-medium text-secondary">{label}: </span>
      {event.oldValue != null ? (
        <TransitionPills before={valueLabel(event.field, event.oldValue)} after={after} />
      ) : (
        <span className="font-semibold text-text-primary">{after}</span>
      )}
    </p>
  );
}

/** A row's own note (e.g. a status/severity/deadline change's changeReason)
 *  -- never rendered for reported_to_ops_change, whose note is already the
 *  "אחרי" value inside CompactChange above. */
function SubordinateNote({ event }: { event: IncidentEvent }) {
  if (!event.note || event.type === 'reported_to_ops_change') return null;
  return <p className="whitespace-pre-wrap break-words text-xs text-secondary">{event.note}</p>;
}

function CorrectionAction({
  event,
  compact,
  currentUserId,
  canCorrectAny,
  onCorrect,
}: {
  event: IncidentEvent;
  compact: boolean;
  currentUserId?: string;
  canCorrectAny?: boolean;
  onCorrect?: (refId: string, label: string) => void;
}) {
  if (!onCorrect || !CORRECTABLE_TYPES.has(event.type)) return null;
  if (event.actorId !== currentUserId && !canCorrectAny) return null;
  return (
    <button
      type="button"
      className={
        compact
          ? 'text-[11px] text-brand-700 hover:underline dark:text-brand-400'
          : 'mt-1 text-xs text-brand-700 hover:underline dark:text-brand-400'
      }
      onClick={() =>
        onCorrect(
          event.type === 'update' && event.refId ? event.refId : event.id,
          `${eventTypeLabels[event.type]} · ${formatDateTime(event.eventTime)}`,
        )
      }
    >
      תיקון רישום זה
    </button>
  );
}

/** Verbose/secondary content behind an accessible expand/collapse control --
 *  only rendered when there's actually something to hide (an empty item
 *  list renders nothing at all, no control shown). The event's own summary
 *  above this is never affected by open/closed state. */
function DetailsDisclosure({ items }: { items: ReactNode[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (items.length === 0) return null;
  return (
    <div className="mt-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
      >
        פרטים נוספים
        <IconChevronDown aria-hidden className={`size-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div id={id} className="mt-1.5 flex flex-col gap-1.5 border-r-2 border-hairline pr-2.5 text-sm">
          {items.map((item, i) => (
            <div key={i}>{item}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function DateSeparator({ label, showLine }: { label: string; showLine: boolean }) {
  return (
    <li className="relative flex items-center gap-3 pt-4 pb-2 first:pt-0">
      {showLine && <span aria-hidden className="absolute top-0 right-[11px] bottom-0 w-px bg-hairline" />}
      <span aria-hidden className="relative z-10 flex size-6 shrink-0 items-center justify-center">
        <span className="size-1.5 rounded-full bg-hairline-strong" />
      </span>
      <span className="text-xs font-semibold text-muted">{label}</span>
    </li>
  );
}

function ActorRow({
  actorId,
  actorLabel,
  profiles,
}: {
  actorId: string | null;
  actorLabel: string | null;
  profiles: Profile[] | undefined;
}) {
  const isHumanActor = !!actorId && !actorLabel;
  const actorProfile = isHumanActor ? profiles?.find((p) => p.id === actorId) : undefined;
  const name = actorDisplayName(actorId, actorLabel, profiles);
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-secondary">
      {isHumanActor && (
        <Avatar
          aria-hidden
          src={actorProfile?.avatarUrl}
          name={name}
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[9px] font-bold text-brand-800 dark:bg-brand-950 dark:text-brand-200"
        />
      )}
      <span>{name}</span>
    </div>
  );
}

function TimelineEntry({
  group,
  showLine,
  events,
  updatesById,
  closuresById,
  treatmentActions,
  treatmentActionsByOperation,
  initialCauseByOperation,
  profiles,
  currentUserId,
  canCorrectAny,
  onCorrect,
  discoveredAt,
  closedAt,
}: {
  group: TimelineGroup;
  showLine: boolean;
  events: IncidentEvent[];
  updatesById: Map<string, IncidentUpdate>;
  closuresById: Map<string, IncidentClosureClassification>;
  treatmentActions: IncidentTreatmentAction[];
  treatmentActionsByOperation: Map<string, IncidentTreatmentAction[]>;
  initialCauseByOperation: Map<string, IncidentCauseAssessment>;
  profiles: Profile[] | undefined;
  currentUserId?: string;
  canCorrectAny?: boolean;
  onCorrect?: (refId: string, label: string) => void;
  discoveredAt?: string;
  closedAt?: string | null;
}) {
  const { primary, subordinates } = group;

  // A correction is never itself a treatment update, even when its refId
  // happens to point at one (the common case: correcting an update's own
  // text) -- it must never pull in and repeat that update's full
  // status/actions/findings/next-steps card.
  const update = primary.type !== 'correction' && primary.refId ? updatesById.get(primary.refId) : undefined;
  const correctionTarget =
    primary.type === 'correction' && primary.refId ? resolveCorrectionTarget(primary.refId, events, updatesById) : undefined;
  const correctedLabel = correctionTarget?.update
    ? 'עדכון הטיפול'
    : correctionTarget?.event
      ? eventTypeLabels[correctionTarget.event.type]
      : null;
  const correctedEventTime = correctionTarget?.update?.eventTime ?? correctionTarget?.event?.eventTime ?? null;
  const laterCorrections = correctionsTargeting(events, primary);
  const timesDiffer = Math.abs(new Date(primary.eventTime).getTime() - new Date(primary.serverTime).getTime()) > 60_000;

  const kind = timelineVisualKind(primary.type);
  const partialReadiness = isPartialReadinessAttempt(primary);
  const rich = isRichTimelineEvent(primary.type) || partialReadiness;
  const Icon = typeIconComponent[primary.type];

  const groupTreatmentActions = group.operationId ? (treatmentActionsByOperation.get(group.operationId) ?? []) : [];
  const initialCause = group.operationId ? initialCauseByOperation.get(group.operationId) : undefined;
  const closure = primary.type === 'closed' && primary.refId ? closuresById.get(primary.refId) : undefined;
  const closureResolvedActions = closure
    ? closure.resolutionActionIds.map((id) => treatmentActions.find((a) => a.id === id)).filter((a): a is IncidentTreatmentAction => !!a)
    : [];

  // Same key every group already uses as its React identity, reused as a
  // DOM anchor id: CurrentStateSummary (the תמונת מצב עדכנית section above
  // this Timeline) computes this exact same id from the source update's
  // originating event to scroll/focus this entry.
  const anchorId = group.operationId ?? primary.id;

  const detailItems: ReactNode[] = [];
  let summary: ReactNode = null;

  if (primary.type === 'closed') {
    summary = (
      <>
        {primary.newValue && (
          <p className="text-sm">
            כשירות בסגירה: <strong>{readinessLabels[primary.newValue as keyof typeof readinessLabels]}</strong>
          </p>
        )}
        {closure && (
          <p className="text-sm">
            <span className="font-medium">גורם שאומת: </span>
            <span>
              {confirmedCauseLabels[closure.confirmedCause]}
              {closure.confirmedCause === 'other' && closure.confirmedCauseOtherDetail ? ` — ${closure.confirmedCauseOtherDetail}` : ''}
            </span>
          </p>
        )}
        {closure && (
          <p className="text-sm">
            <span className="font-medium">תוצאה: </span>
            <span>
              {treatmentOutcomeLabels[closure.treatmentOutcome]}
              {closure.treatmentOutcome === 'other' && closure.treatmentOutcomeOtherDetail ? ` — ${closure.treatmentOutcomeOtherDetail}` : ''}
            </span>
            {closure.treatmentOutcome === 'temporary_workaround' && (
              <span className="mr-1.5 inline-flex items-center rounded-md border border-orange-300 bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-900 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200">
                פתרון זמני
              </span>
            )}
          </p>
        )}
        {discoveredAt && closedAt && (
          <p className="text-sm font-bold text-text-primary">משך התקלה: {formatDuration(discoveredAt, closedAt)}</p>
        )}
      </>
    );
    if (primary.note) {
      detailItems.push(<p className="whitespace-pre-wrap break-words">{primary.note}</p>);
    }
    if (primary.userNote) {
      detailItems.push(
        <p>
          <span className="font-medium">הערה נוספת: </span>
          <span className="whitespace-pre-wrap break-words">{primary.userNote}</span>
        </p>,
      );
    }
    if (closure) {
      detailItems.push(
        <p>
          <span className="font-medium">מה ידוע על מה שהוביל לפתרון: </span>
          <span>
            {resolutionAttributionLabels[closure.resolutionAttribution]}
            {closure.resolutionAttribution === 'other' && closure.resolutionAttributionOtherDetail
              ? ` — ${closure.resolutionAttributionOtherDetail}`
              : ''}
          </span>
        </p>,
      );
    }
    if (closureResolvedActions.length > 0) {
      detailItems.push(<TreatmentActionChips actions={closureResolvedActions} />);
    }
  } else if (update) {
    summary = (
      <>
        {update.currentStatusText && (
          <p className="text-sm">
            <span className="font-medium">{fieldLabels.current_status_text}: </span>
            <span className="whitespace-pre-wrap break-words">{update.currentStatusText}</span>
          </p>
        )}
        <p className="text-sm">
          <span className="font-medium">פעולות שבוצעו: </span>
          <span className="whitespace-pre-wrap break-words">{update.actionsTaken}</span>
        </p>
        <TreatmentActionChips actions={groupTreatmentActions} />
      </>
    );
    if (update.findings) {
      detailItems.push(
        <p>
          <span className="font-medium">ממצאים: </span>
          <span className="whitespace-pre-wrap break-words">{update.findings}</span>
        </p>,
      );
    }
    if (update.nextSteps) {
      detailItems.push(
        <p>
          <span className="font-medium">פעולות המשך: </span>
          <span className="whitespace-pre-wrap break-words">{update.nextSteps}</span>
        </p>,
      );
    }
    if (update.userNote) {
      detailItems.push(
        <p>
          <span className="font-medium">הערה נוספת: </span>
          <span className="whitespace-pre-wrap break-words">{update.userNote}</span>
        </p>,
      );
    }
    // Update-specific reporting: fresh answers recorded for THIS update
    // only, never the incident's own opening-time reporting facts. Each
    // line renders only when an answer was actually recorded -- null
    // (never asked / a legacy row predating this feature / an old-client
    // payload that omitted the key) renders nothing, not a "לא" default.
    if (update.updateReportedToOps != null) {
      detailItems.push(
        <p>
          <span className="font-medium">דווח למבצעים בעדכון זה: </span>
          <span>{reportedToOpsLabels[update.updateReportedToOps]}</span>
          {update.updateReportedToOps === 'yes' && update.updateReportedToOpsRecipient && <span> ({update.updateReportedToOpsRecipient})</span>}
        </p>,
      );
    }
    if (update.updateReportedToComms != null) {
      detailItems.push(
        <p>
          <span className="font-medium">דווח לתקשוב למבצעים בעדכון זה: </span>
          <span>{update.updateReportedToComms ? 'כן' : 'לא'}</span>
          {update.updateReportedToComms && update.updateReportedToCommsRecipient && <span> ({update.updateReportedToCommsRecipient})</span>}
        </p>,
      );
    }
    if (update.updateWisdomReported != null) {
      detailItems.push(
        <p>
          <span className="font-medium">עודכן ב-WISDOM בעדכון זה: </span>
          <span>{update.updateWisdomReported ? 'כן' : 'לא'}</span>
        </p>,
      );
    }
  } else if (primary.type === 'created') {
    // The generated note bundles the free-text opening description with
    // (when answered) the opening-time comms/WISDOM narrative -- often
    // several lines, sometimes paragraphs -- so it's verbose secondary
    // content like an update's findings/next steps, not the always-visible
    // summary. The structured facts that actually matter for a quick scan
    // (suspected cause, treatment-action classification, and any
    // status/reporting deltas recorded in the same operation -- rendered
    // below as nested compact rows) stay primary on their own.
    summary = (
      <>
        {initialCause && (
          <p className="text-sm">
            <span className="font-medium">חשד ראשוני: </span>
            <span>
              {suspectedCauseLabels[initialCause.cause]}
              {initialCause.cause === 'other' && initialCause.otherDetail ? ` — ${initialCause.otherDetail}` : ''}
            </span>
            <span className="text-xs text-muted"> — תועד בעת פתיחת התקלה</span>
          </p>
        )}
        <TreatmentActionChips actions={groupTreatmentActions} />
      </>
    );
    if (primary.note) detailItems.push(<p className="whitespace-pre-wrap break-words">{primary.note}</p>);
    if (primary.userNote) {
      detailItems.push(
        <p>
          <span className="font-medium">הערה נוספת: </span>
          <span className="whitespace-pre-wrap break-words">{primary.userNote}</span>
        </p>,
      );
    }
  } else if (primary.type === 'correction') {
    summary = (
      <>
        <CompactChange event={primary} />
        {primary.note && (
          <p className="rounded-lg bg-surface-active p-2.5 text-sm">
            <span className="font-medium text-text-primary">תיקון: </span>
            <bdi dir="auto" className="whitespace-pre-wrap break-words text-secondary">
              {primary.note}
            </bdi>
          </p>
        )}
        <p className="text-xs text-muted">
          {correctedLabel && correctedEventTime ? (
            <>
              מתייחס ל{correctedLabel} מ־{formatDate(correctedEventTime)} בשעה {formatTime(correctedEventTime)}
            </>
          ) : (
            'מתייחס לרישום קודם (הרישום המקורי נשמר)'
          )}
        </p>
      </>
    );
  } else {
    // Every other type -- a single field delta or a lifecycle-adjacent
    // event with no structured record of its own (reopened, cancelled,
    // acknowledged, follow_up_completed, severity_assessed,
    // status_check_changed, cause_assessment_changed, handover_*).
    // Always short by construction, so it stays fully visible with no
    // "פרטים נוספים" control at all.
    summary = (
      <>
        <CompactChange event={primary} />
        <SubordinateNote event={primary} />
        {primary.userNote && primary.type !== 'reported_to_ops_change' && (
          <p className="text-sm">
            <span className="font-medium">הערה נוספת: </span>
            <span className="whitespace-pre-wrap break-words">{primary.userNote}</span>
          </p>
        )}
      </>
    );
  }

  const titleText = primary.type === 'correction' ? 'תיקון לרישום קודם' : eventTypeLabels[primary.type];

  return (
    <li
      id={`timeline-entry-${anchorId}`}
      tabIndex={-1}
      className="relative flex gap-3 pb-4 outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-brand-600"
    >
      {showLine && <span aria-hidden className="absolute top-7 right-[11px] bottom-0 w-px bg-hairline" />}
      <span
        aria-hidden
        className={`relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
          rich ? solidMarkerClasses[kind] : mutedMarkerClasses[kind]
        }`}
      >
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={rich ? 'text-base font-bold text-text-primary' : 'text-sm font-semibold text-text-primary'}>{titleText}</span>
          <span className="shrink-0 text-xs font-semibold text-text-secondary">{formatTime(primary.eventTime)}</span>
        </div>
        <ActorRow actorId={primary.actorId} actorLabel={primary.actorLabel} profiles={profiles} />
        {timesDiffer && <p className="mt-0.5 text-[11px] text-muted">תועד במערכת: {formatDateTime(primary.serverTime)}</p>}
        {primary.type !== 'correction' && laterCorrections.length > 0 && (
          <p className="mt-0.5 text-[11px] text-muted">רישום זה תוקן בהמשך</p>
        )}
        {partialReadiness && (
          <p className="mt-1 inline-flex items-center gap-1 rounded-md border border-orange-300 bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-900 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200">
            התקלה נותרת פעילה — כשירות חלקית, ממתינה להשלמת פעולות המשך
          </p>
        )}
        <div className="mt-1.5 flex flex-col gap-1.5">{summary}</div>
        <CorrectionAction event={primary} compact={false} currentUserId={currentUserId} canCorrectAny={canCorrectAny} onCorrect={onCorrect} />
        {subordinates.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {subordinates.map((sub) => (
              <div key={sub.id}>
                <CompactChange event={sub} />
                <SubordinateNote event={sub} />
                <CorrectionAction event={sub} compact currentUserId={currentUserId} canCorrectAny={canCorrectAny} onCorrect={onCorrect} />
              </div>
            ))}
          </div>
        )}
        <DetailsDisclosure items={detailItems} />
      </div>
    </li>
  );
}

export function Timeline({
  events,
  updates,
  profiles,
  currentUserId,
  canCorrectAny,
  onCorrect,
  discoveredAt,
  closedAt,
  causeAssessments,
  treatmentActions,
  closures,
}: {
  events: IncidentEvent[];
  updates: IncidentUpdate[];
  profiles: Profile[] | undefined;
  currentUserId?: string;
  canCorrectAny?: boolean;
  onCorrect?: (refId: string, label: string) => void;
  /** The incident's own discoveredAt/closedAt -- used only to show the
   *  operational duration on the closure event below. Deliberately the
   *  persisted effective times, never the event's own recording (server)
   *  timestamp or the current clock. */
  discoveredAt?: string;
  closedAt?: string | null;
  /** Structured lifecycle classification data -- all optional so this
   *  component still renders correctly (simply without these sections) for
   *  any caller that hasn't wired them up yet. Joined onto the relevant
   *  primary event by operationId (causeAssessments/treatmentActions) or by
   *  refId (closures), never rendered as separate timeline events of their
   *  own. */
  causeAssessments?: IncidentCauseAssessment[];
  treatmentActions?: IncidentTreatmentAction[];
  closures?: IncidentClosureClassification[];
}) {
  const updatesById = new Map(updates.map((u) => [u.id, u]));
  const closuresById = new Map((closures ?? []).map((c) => [c.id, c]));
  const treatmentActionsByOperation = new Map<string, IncidentTreatmentAction[]>();
  for (const a of treatmentActions ?? []) {
    if (!a.operationId) continue;
    const list = treatmentActionsByOperation.get(a.operationId) ?? [];
    list.push(a);
    treatmentActionsByOperation.set(a.operationId, list);
  }
  const initialCauseByOperation = new Map<string, IncidentCauseAssessment>();
  for (const c of causeAssessments ?? []) {
    // Only the initial, creation-time assessment (no known effective time)
    // is rendered inline this way -- every later change already gets its
    // own explicit cause_assessment_changed event via CompactChange.
    if (c.operationId && c.eventTime === null) initialCauseByOperation.set(c.operationId, c);
  }

  if (events.length === 0) {
    return <p className="py-4 text-sm text-muted">אין אירועים בציר הזמן.</p>;
  }

  const groups = groupTimelineEvents(events);
  const dateBuckets = groupByCalendarDate(groups);

  type Row = { kind: 'date'; key: string; label: string } | { kind: 'group'; key: string; group: TimelineGroup };
  const rows: Row[] = [];
  for (const bucket of dateBuckets) {
    rows.push({ kind: 'date', key: `date-${rows.length}`, label: bucket.dateLabel });
    for (const group of bucket.groups) {
      rows.push({ kind: 'group', key: group.operationId ?? group.primary.id, group });
    }
  }

  return (
    <ol className="relative flex flex-col gap-0">
      {rows.map((row, idx) =>
        row.kind === 'date' ? (
          <DateSeparator key={row.key} label={row.label} showLine={idx < rows.length - 1} />
        ) : (
          <TimelineEntry
            key={row.key}
            group={row.group}
            showLine={idx < rows.length - 1}
            events={events}
            updatesById={updatesById}
            closuresById={closuresById}
            treatmentActions={treatmentActions ?? []}
            treatmentActionsByOperation={treatmentActionsByOperation}
            initialCauseByOperation={initialCauseByOperation}
            profiles={profiles}
            currentUserId={currentUserId}
            canCorrectAny={canCorrectAny}
            onCorrect={onCorrect}
            discoveredAt={discoveredAt}
            closedAt={closedAt}
          />
        ),
      )}
    </ol>
  );
}
