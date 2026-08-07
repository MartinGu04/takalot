// תמונת מצב עדכנית -- derives the incident detail page's compact "current
// state" summary purely from already-loaded incident/update/event data. No
// new field, no new RPC: this only decides which already-recorded piece of
// information best represents "what's going on right now."
import type { Incident, IncidentClosureClassification, IncidentEvent, IncidentUpdate } from './types';

export type CurrentStateSummary =
  | { kind: 'active'; update: IncidentUpdate; anchorId: string | undefined }
  | { kind: 'no_update' }
  | { kind: 'no_update_since_reopen' }
  | { kind: 'closed'; closure: IncidentClosureClassification | undefined }
  | { kind: 'cancelled' };

function hasMeaningfulStatusText(update: IncidentUpdate): boolean {
  return typeof update.currentStatusText === 'string' && update.currentStatusText.trim().length > 0;
}

function later<T extends { serverTime: string }>(a: T | undefined, b: T): T {
  if (!a) return b;
  return new Date(b.serverTime).getTime() > new Date(a.serverTime).getTime() ? b : a;
}

/**
 * Selects which recorded update (if any) represents the incident's current
 * operational state, and what final/closed/cancelled state to show instead
 * when the incident isn't active.
 *
 * Cycle-boundary and "latest" decisions are made on `serverTime` (the
 * authoritative, non-user-editable recording time), never on `eventTime`
 * (user-entered "when it actually happened", freely backdatable between
 * discoveredAt and now -- see UpdateDialog's eventTimeBoundsError). Using
 * eventTime for the reopen boundary would let a backdated update either
 * wrongly disappear from the current cycle (false "no update since reopen")
 * or wrongly leak a previous cycle's update into the current one -- the
 * exact correctness failure this feature must avoid. serverTime mirrors the
 * same precedent already established elsewhere in this schema: `cycleNumber`
 * on IncidentCauseAssessment/IncidentTreatmentAction/IncidentClosureClassification
 * is assigned at write time (real submission order), and `last_update_at` is
 * always stamped with `now()`, never the caller's eventTime.
 */
export function selectCurrentStateSummary(
  incident: Incident,
  updates: readonly IncidentUpdate[],
  events: readonly IncidentEvent[],
  closures: readonly IncidentClosureClassification[] | undefined,
): CurrentStateSummary {
  if (incident.status === 'cancelled') return { kind: 'cancelled' };

  if (incident.status === 'closed') {
    // Same pattern already used by IncidentDetailPage's "סיכום סגירה" block:
    // the classification row for the closure that produced THIS closed
    // state is the one whose cycleNumber matches the incident's own
    // reopenCount. Absent for a legacy/unclassified closure -- never
    // fabricated.
    const closure = closures?.find((c) => c.cycleNumber === incident.reopenCount);
    return { kind: 'closed', closure };
  }

  // Active (any open status, including a freshly reopened incident whose
  // status literally reads 'reopened'). Find the most recent reopen -- there
  // may be several across the incident's life -- to bound "the current
  // treatment cycle".
  let lastReopen: IncidentEvent | undefined;
  for (const event of events) {
    if (event.type === 'reopened') lastReopen = later(lastReopen, event);
  }

  // Defensive fail-closed: reopenCount says this incident WAS reopened, but
  // no 'reopened' event could be located (e.g. events still loading, or
  // genuinely anomalous data). Never trust any update as belonging to "the
  // current cycle" without proof it postdates a reopen -- falls through to
  // the reopen-specific empty state below rather than risking a stale
  // pre-reopen status leaking through.
  const cycleUnprovable = incident.reopenCount > 0 && !lastReopen;

  const qualifying = cycleUnprovable
    ? []
    : updates.filter((u) => {
        if (!hasMeaningfulStatusText(u)) return false;
        if (!lastReopen) return true;
        return new Date(u.serverTime).getTime() > new Date(lastReopen.serverTime).getTime();
      });

  let latest: IncidentUpdate | undefined;
  for (const u of qualifying) latest = later(latest, u);

  if (latest) {
    // The update event whose refId points at this update -- always the
    // primary of its own timeline group (see Timeline.tsx/timelineGrouping.ts:
    // 'update' only ever shares an operationId with delta-change rows from
    // the same update_incident/technician_update_incident call, never with
    // another lifecycle-defining type). Its group anchor is what the
    // Timeline itself renders an id for.
    const sourceEvent = events.find((e) => e.type === 'update' && e.refId === latest!.id);
    const anchorId = sourceEvent ? (sourceEvent.operationId ?? sourceEvent.id) : undefined;
    return { kind: 'active', update: latest, anchorId };
  }

  return incident.reopenCount > 0 ? { kind: 'no_update_since_reopen' } : { kind: 'no_update' };
}
