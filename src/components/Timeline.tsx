// Unified chronological incident timeline. One user operation (one shared,
// non-null operationId) renders as one grouped item; a primary event is
// chosen for the item and every other row from that operation renders as a
// compact subordinate change inside it. operationId=null (legacy) rows are
// never grouped with anything -- see domain/timelineGrouping.ts. Readable on
// mobile; does not rely on color, arrows, or strikethrough alone.
import type { EventType, IncidentEvent, IncidentUpdate, Profile } from '../domain/types';
import { groupTimelineEvents } from '../domain/timelineGrouping';
import {
  eventTypeLabels,
  fieldLabels,
  severityLabels,
  statusLabels,
  readinessLabels,
  reportedToOpsLabels,
} from '../domain/labels';
import { formatDateTime, formatDuration, formatDate, formatTime } from '../lib/time';
import { Avatar } from './ui';

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
  if (field === 'next_update_due') return value === 'null' || !value ? 'ללא צפי' : formatDateTime(value);
  if (field === 'status_check_due') return value === 'null' || !value ? 'ללא' : formatDateTime(value);
  return value;
}

const typeIcon: Record<string, string> = {
  created: '●',
  acknowledged: '✓',
  update: '✎',
  status_change: '⇄',
  severity_change: '!',
  impact_change: '!',
  assignment_change: '→',
  deadline_change: '⏱',
  reported_to_ops_change: '↗',
  correction: '±',
  handover_included: '⇉',
  handover_accepted: '⇉',
  closed: '■',
  follow_up_completed: '✓',
  reopened: '↺',
  cancelled: '✕',
  severity_assessed: '!',
  status_check_changed: '☑',
  reported_to_ops_room: '↗',
  reported_to_ops_communications: '↗',
};

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

/** Creation, closure, reopening, cancellation: the incident's own lifecycle. */
const LIFECYCLE_TYPES = new Set<EventType>(['created', 'closed', 'reopened', 'cancelled']);

/**
 * close_incident's partial-readiness branch: the incident does NOT close --
 * it stays active, status moves to partial_readiness, follow-up stays
 * outstanding. Deliberately not a member of LIFECYCLE_TYPES (it must never
 * read as a completed closure), but still a significant operation, so it
 * gets its own medium-emphasis tier instead of the plain neutral one.
 */
function isPartialReadinessAttempt(event: IncidentEvent): boolean {
  return event.type === 'status_change' && event.field === 'status' && event.newValue === 'partial_readiness';
}

type EmphasisTier = 'strong' | 'medium' | 'neutral';

function emphasisTier(primary: IncidentEvent): EmphasisTier {
  if (LIFECYCLE_TYPES.has(primary.type)) return 'strong';
  if (isPartialReadinessAttempt(primary)) return 'medium';
  return 'neutral';
}

const iconRoundelClasses: Record<EmphasisTier, string> = {
  strong: 'bg-brand-600 text-white dark:bg-brand-500',
  medium:
    'bg-orange-100 text-orange-900 border border-orange-300 dark:bg-orange-950 dark:text-orange-200 dark:border-orange-800',
  neutral: 'bg-surface-active text-text-secondary',
};

const titleClasses: Record<EmphasisTier, string> = {
  strong: 'text-base font-extrabold text-text-primary',
  medium: 'font-bold text-text-primary',
  neutral: 'font-semibold text-text-primary',
};

/** The actual event time is always the primary, prominent timestamp -- see
 *  the "תועד במערכת:" secondary line below for the server-recorded time,
 *  which only appears when it differs from this one by more than 60s. */
const eventTimeClasses: Record<EmphasisTier, string> = {
  strong: 'text-base font-bold text-text-primary',
  medium: 'text-sm font-semibold text-text-primary',
  neutral: 'text-sm font-semibold text-text-secondary',
};

/**
 * One field's before/after, always with explicit לפני/אחרי labels -- never
 * conveyed by arrow direction, strikethrough, or color alone.
 *
 * reported_to_ops_change is a special case: old_value/new_value only ever
 * carry the recipient text, while the row's own note carries the fuller
 * "status (recipient)" fact (e.g. "דווח למבצעים: כן (יוסי)"). Rendering the
 * generic field diff AND the note would repeat the recipient and still miss
 * the status on the diff side, so this renders once: לפני = previous
 * recipient (all that's available), אחרי = the note (the richer, complete
 * fact) -- no separate note paragraph follows it, here or at the call site
 * (see the reported_to_ops_change exclusion everywhere event.note is
 * otherwise rendered, both for the group's primary and for subordinates).
 *
 * Deliberately never renders event.note itself: the primary's own note (if
 * any) is already shown once by the caller's dedicated note paragraph, and
 * duplicating it here would print it twice on every group whose primary
 * carries both a field and a note (e.g. cancelled, or a lone assignment
 * change). Subordinate notes are rendered by the caller too, for the same
 * reason -- one place decides whether a note is shown, not two.
 */
function FieldChangeRow({ event }: { event: IncidentEvent }) {
  // Plain div/span, deliberately not a semantic <dl>/<dt>/<dd> -- <dd>
  // carries an implicit role="definition", which would collide with the
  // incident-detail summary's own definition list (several e2e specs scope
  // getByRole('definition') to that summary specifically, e.g. the internal
  // owner / external handler facts). The לפני/אחרי pairing is already
  // conveyed by the visible label text and DOM order.
  if (event.type === 'reported_to_ops_change') {
    return (
      <div className="mt-1.5 text-sm">
        <p className="font-medium text-secondary">{fieldLabels.reported_to_ops}:</p>
        <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5">
          <div className="flex items-baseline gap-1">
            <span className="text-xs text-muted">לפני:</span>
            <span className="text-secondary">{event.oldValue ?? 'ללא'}</span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-xs text-muted">אחרי:</span>
            <span className="whitespace-pre-wrap break-words font-semibold text-text-primary">{event.note}</span>
          </div>
        </div>
      </div>
    );
  }
  if (!event.field) return null;
  return (
    <div className="mt-1.5 text-sm">
      <p className="font-medium text-secondary">{fieldLabels[event.field] ?? event.field}:</p>
      <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5">
        <div className="flex items-baseline gap-1">
          <span className="text-xs text-muted">לפני:</span>
          <span className="text-secondary">{valueLabel(event.field, event.oldValue)}</span>
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-xs text-muted">אחרי:</span>
          <span className="font-semibold text-text-primary">{valueLabel(event.field, event.newValue)}</span>
        </div>
      </div>
    </div>
  );
}

/** A subordinate row's own note (e.g. a status/severity/deadline change's
 *  changeReason) -- never rendered for reported_to_ops_change, whose note is
 *  already the "אחרי" value inside FieldChangeRow above. */
function SubordinateNote({ event }: { event: IncidentEvent }) {
  if (!event.note || event.type === 'reported_to_ops_change') return null;
  return <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-secondary">{event.note}</p>;
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
          ? 'mt-1 text-[11px] text-brand-700 hover:underline dark:text-brand-400'
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

export function Timeline({
  events,
  updates,
  profiles,
  currentUserId,
  canCorrectAny,
  onCorrect,
  discoveredAt,
  closedAt,
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
}) {
  const updatesById = new Map(updates.map((u) => [u.id, u]));
  const actorName = (id: string | null, label: string | null) =>
    label ?? (id ? (profiles?.find((p) => p.id === id)?.fullName ?? 'משתמש') : 'המערכת');

  if (events.length === 0) {
    return <p className="py-4 text-sm text-muted">אין אירועים בציר הזמן.</p>;
  }

  const groups = groupTimelineEvents(events);

  return (
    <ol className="relative flex flex-col gap-0">
      {groups.map((group, idx) => {
        const { primary, subordinates } = group;
        // A correction is never itself a treatment update, even when its
        // refId happens to point at one (the common case: correcting an
        // update's own text) -- it must never pull in and repeat that
        // update's full status/actions/findings/next-steps card.
        const update = primary.type !== 'correction' && primary.refId ? updatesById.get(primary.refId) : undefined;
        const correctionTarget =
          primary.type === 'correction' && primary.refId
            ? resolveCorrectionTarget(primary.refId, events, updatesById)
            : undefined;
        const correctedLabel = correctionTarget?.update
          ? 'עדכון הטיפול'
          : correctionTarget?.event
            ? eventTypeLabels[correctionTarget.event.type]
            : null;
        const correctedEventTime = correctionTarget?.update?.eventTime ?? correctionTarget?.event?.eventTime ?? null;
        const laterCorrections = correctionsTargeting(events, primary);
        const timesDiffer =
          Math.abs(new Date(primary.eventTime).getTime() - new Date(primary.serverTime).getTime()) > 60_000;
        const tier = emphasisTier(primary);
        const changesHeading = primary.type === 'update' ? 'שינויים בעדכון' : 'שינויים נוספים';
        // A real internal actor -- as opposed to a system-generated row
        // (actorId null) or an external actor display (actorLabel set,
        // never a real profile) -- gets a compact avatar next to their
        // name. System/external rows keep the existing type-icon roundel
        // only; never a fictional person or avatar.
        const isHumanActor = !!primary.actorId && !primary.actorLabel;
        const actorProfile = isHumanActor ? profiles?.find((p) => p.id === primary.actorId) : undefined;
        const actorDisplayName = actorName(primary.actorId, primary.actorLabel);

        return (
          <li key={group.operationId ?? primary.id} className="relative flex gap-3 pb-4">
            {idx < groups.length - 1 && (
              <span
                aria-hidden
                className="absolute top-7 right-[11px] bottom-0 w-px bg-hairline"
              />
            )}
            <span
              aria-hidden
              className={`relative z-10 mt-1 flex size-6 shrink-0 items-center justify-center rounded-full text-xs ${iconRoundelClasses[tier]}`}
            >
              {typeIcon[primary.type] ?? '•'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                {/* A correction is an audit entry that amends a previous
                    record, not a new treatment update -- its own title says
                    so explicitly rather than reusing the generic "תיקון
                    רישום" label (still used elsewhere, e.g. PDF export). */}
                <span className={titleClasses[tier]}>
                  {primary.type === 'correction' ? 'תיקון לרישום קודם' : eventTypeLabels[primary.type]}
                </span>
                <span className="flex items-center gap-1.5 text-sm text-secondary">
                  {isHumanActor && (
                    <Avatar
                      aria-hidden
                      src={actorProfile?.avatarUrl}
                      name={actorDisplayName}
                      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[9px] font-bold text-brand-800 dark:bg-brand-950 dark:text-brand-200"
                    />
                  )}
                  {actorDisplayName}
                </span>
              </div>
              {tier === 'medium' && (
                <p className="mt-1 inline-flex items-center gap-1 rounded-md border border-orange-300 bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-900 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200">
                  התקלה נותרת פעילה — כשירות חלקית, ממתינה להשלמת פעולות המשך
                </p>
              )}
              <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className={eventTimeClasses[tier]}>{formatDateTime(primary.eventTime)}</span>
              </div>
              {timesDiffer && (
                <p className="mt-0.5 text-xs text-muted">תועד במערכת: {formatDateTime(primary.serverTime)}</p>
              )}
              {/* Derived from the already-fetched events, never a new field:
                  a correction's own refId targets either this event's id or
                  (for a corrected update) its backing IncidentUpdate.id --
                  see resolveCorrectionTarget/correctionsTargeting above. The
                  original content itself is never touched. */}
              {primary.type !== 'correction' && laterCorrections.length > 0 && (
                <p className="mt-0.5 text-xs text-muted">רישום זה תוקן בהמשך</p>
              )}
              <FieldChangeRow event={primary} />
              {primary.type === 'closed' && primary.newValue && (
                <p className="mt-1 text-sm">
                  כשירות בסגירה:{' '}
                  <strong>{readinessLabels[primary.newValue as keyof typeof readinessLabels]}</strong>
                </p>
              )}
              {update && (
                <div className="mt-1.5 rounded-lg bg-surface-active p-2.5 text-sm">
                  {update.currentStatusText && (
                    <p>
                      <span className="font-medium">{fieldLabels.current_status_text}: </span>
                      <span className="whitespace-pre-wrap break-words">{update.currentStatusText}</span>
                    </p>
                  )}
                  <p className={update.currentStatusText ? 'mt-1' : ''}>
                    <span className="font-medium">פעולות שבוצעו: </span>
                    <span className="whitespace-pre-wrap break-words">{update.actionsTaken}</span>
                  </p>
                  {update.findings && (
                    <p className="mt-1">
                      <span className="font-medium">ממצאים: </span>
                      <span className="whitespace-pre-wrap break-words">{update.findings}</span>
                    </p>
                  )}
                  {update.nextSteps && (
                    <p className="mt-1">
                      <span className="font-medium">פעולות המשך: </span>
                      <span className="whitespace-pre-wrap break-words">{update.nextSteps}</span>
                    </p>
                  )}
                  {update.userNote && (
                    <p className="mt-1">
                      <span className="font-medium">הערה נוספת: </span>
                      <span className="whitespace-pre-wrap break-words">{update.userNote}</span>
                    </p>
                  )}
                  {/* Update-specific reporting: fresh answers recorded for
                      THIS update only, never the incident's own opening-time
                      reporting facts. Each line renders only when an answer
                      was actually recorded -- null (never asked / a legacy
                      row predating this feature / an old-client payload that
                      omitted the key) renders nothing, not a "לא" default. */}
                  {update.updateReportedToOps != null && (
                    <p className="mt-1">
                      <span className="font-medium">דווח למבצעים בעדכון זה: </span>
                      <span>{reportedToOpsLabels[update.updateReportedToOps]}</span>
                      {update.updateReportedToOps === 'yes' && update.updateReportedToOpsRecipient && (
                        <span> ({update.updateReportedToOpsRecipient})</span>
                      )}
                    </p>
                  )}
                  {update.updateReportedToComms != null && (
                    <p className="mt-1">
                      <span className="font-medium">דווח לתקשוב למבצעים בעדכון זה: </span>
                      <span>{update.updateReportedToComms ? 'כן' : 'לא'}</span>
                      {update.updateReportedToComms && update.updateReportedToCommsRecipient && (
                        <span> ({update.updateReportedToCommsRecipient})</span>
                      )}
                    </p>
                  )}
                  {update.updateWisdomReported != null && (
                    <p className="mt-1">
                      <span className="font-medium">עודכן ב-WISDOM בעדכון זה: </span>
                      <span>{update.updateWisdomReported ? 'כן' : 'לא'}</span>
                    </p>
                  )}
                </div>
              )}
              {/* Correction content: the persisted correction note, shown
                  verbatim (never rewritten into a more specific claim the
                  data doesn't actually support) with an explicit "תיקון:"
                  label -- deliberately its own block, never the corrected
                  record's own status/actions/findings/next-steps fields,
                  which stay on the ORIGINAL entry only. A field-level diff
                  (if this correction ever carries one) already rendered
                  above via the generic FieldChangeRow. */}
              {primary.type === 'correction' && primary.note && (
                <div className="mt-1.5 rounded-lg bg-surface-active p-2.5 text-sm">
                  <span className="font-medium text-text-primary">תיקון: </span>
                  <bdi dir="auto" className="whitespace-pre-wrap break-words text-secondary">
                    {primary.note}
                  </bdi>
                </div>
              )}
              {primary.note && !update && primary.type !== 'reported_to_ops_change' && primary.type !== 'correction' && (
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-secondary">
                  {primary.note}
                </p>
              )}
              {primary.userNote && !update && primary.type !== 'reported_to_ops_change' && (
                <p className="mt-1 text-sm">
                  <span className="font-medium">הערה נוספת: </span>
                  <span className="whitespace-pre-wrap break-words">{primary.userNote}</span>
                </p>
              )}
              {primary.type === 'closed' && discoveredAt && closedAt && (
                <p className="mt-1 text-sm font-bold text-text-primary">
                  משך התקלה: {formatDuration(discoveredAt, closedAt)}
                </p>
              )}
              {primary.type === 'correction' && (
                <p className="mt-0.5 text-xs text-muted">
                  {correctedLabel && correctedEventTime ? (
                    <>
                      מתייחס ל{correctedLabel} מ־{formatDate(correctedEventTime)} בשעה {formatTime(correctedEventTime)}
                    </>
                  ) : (
                    'מתייחס לרישום קודם (הרישום המקורי נשמר)'
                  )}
                </p>
              )}
              <CorrectionAction
                event={primary}
                compact={false}
                currentUserId={currentUserId}
                canCorrectAny={canCorrectAny}
                onCorrect={onCorrect}
              />
              {subordinates.length > 0 && (
                <div className="mt-2 rounded-lg border border-hairline bg-surface-active/60 p-2.5">
                  <p className="group-title">{changesHeading}</p>
                  <ul className="mt-1.5 flex flex-col gap-2">
                    {subordinates.map((sub) => (
                      <li key={sub.id} className="border-t border-hairline pt-2 first:border-t-0 first:pt-0">
                        <FieldChangeRow event={sub} />
                        <SubordinateNote event={sub} />
                        <CorrectionAction
                          event={sub}
                          compact
                          currentUserId={currentUserId}
                          canCorrectAny={canCorrectAny}
                          onCorrect={onCorrect}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
