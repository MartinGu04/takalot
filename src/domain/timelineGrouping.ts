// Pure grouping logic for the incident Timeline (E2). One user operation
// (one shared, non-null operationId) becomes one timeline item; a primary
// event is chosen for the item and every other row in that operation
// becomes a subordinate change rendered inside it.
//
// operationId === null (every row written before this column existed --
// permanently so, incident_events is append-only) is NEVER grouped with
// anything else, including another null row with the same eventTime: null
// carries no operation identity to group by, so each such row stays its own
// independent item. See migration 0025's header for why this can never be
// backfilled.
//
// Rows sharing one operationId are always written by the same RPC call
// within one transaction, so they always share actorId and (per schema
// defaults / explicitly-passed event_time) eventTime too -- see 0026's
// per-function inserts. But nothing in the schema guarantees the ORDER the
// database returns same-eventTime rows in (the read query only orders by
// event_time; see supabaseRepository.getIncidentEvents), so primary
// selection and subordinate ordering below are both driven entirely by
// event *content* (type, field, values) via an explicit priority table --
// never by array/DB arrival order.
import type { EventType, IncidentEvent } from './types';

export interface TimelineGroup {
  operationId: string | null;
  primary: IncidentEvent;
  /** Every other event in the operation, in deterministic display order. */
  subordinates: IncidentEvent[];
}

/**
 * Explicit total order over every EventType, most "operation-defining" /
 * lifecycle-significant first. Used for BOTH primary selection (lowest
 * index wins) and subordinate ordering (ascending index) -- one table, one
 * meaning, so the two can never disagree about what matters more.
 *
 * The six "_change" delta types are last and, among themselves, follow the
 * order update_incident's own RPC body asks them (status, severity,
 * impact, assignment, deadline, reported-to-ops) -- a reading order already
 * chosen deliberately by that function, reused here rather than reinvented.
 */
const TYPE_PRIORITY: EventType[] = [
  'created',
  'closed',
  'cancelled',
  'reopened',
  'update',
  'acknowledged',
  'follow_up_completed',
  'correction',
  'handover_accepted',
  'handover_included',
  'reported_to_ops_room',
  'reported_to_ops_communications',
  'severity_assessed',
  'status_change',
  'status_check_changed',
  'severity_change',
  'impact_change',
  'assignment_change',
  'deadline_change',
  'reported_to_ops_change',
];

function priorityIndex(type: EventType): number {
  const idx = TYPE_PRIORITY.indexOf(type);
  return idx === -1 ? TYPE_PRIORITY.length : idx;
}

/**
 * The one case current RPCs can produce two rows of the identical type in
 * one operation: set_incident_status_check('completed', { nextDueAt }),
 * which stamps both the just-completed check (status_check_due: <date> ->
 * null) and the freshly-scheduled next one (status_check_due: null ->
 * <date>) with the same operationId. Locked product decision: completion is
 * primary, the next-scheduled check is subordinate. That is fully
 * determined by each row's own new_value (null = closing one out; non-null
 * = opening the next one) -- content, not arrival order.
 */
function isClosingStatusCheck(event: IncidentEvent): boolean {
  return event.type === 'status_check_changed' && event.newValue == null;
}

/** Deterministic, content-only comparator: never falls back to array index. */
function compareEvents(a: IncidentEvent, b: IncidentEvent): number {
  const pa = priorityIndex(a.type);
  const pb = priorityIndex(b.type);
  if (pa !== pb) return pa - pb;
  if (a.type === 'status_check_changed' && b.type === 'status_check_changed') {
    const ca = isClosingStatusCheck(a) ? 0 : 1;
    const cb = isClosingStatusCheck(b) ? 0 : 1;
    if (ca !== cb) return ca - cb;
  }
  // Same type, and not the status-check case above (never produced by any
  // current RPC, but kept total and deterministic for safety): stable,
  // reproducible, content-derived tiebreak that owes nothing to how the
  // database happened to return the rows.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Explicit-priority primary selection with a safe, deterministic fallback.
 * Does NOT assume a group always has exactly one "operation-defining" (i.e.
 * non-delta) row -- every current RPC happens to produce at most one, but
 * the selection itself never depends on that being true: it always picks
 * the single lowest-priority-index event by content, with the same
 * content-based tiebreak compareEvents uses everywhere else.
 */
export function selectPrimaryEvent(events: readonly IncidentEvent[]): IncidentEvent {
  if (events.length === 0) {
    throw new Error('selectPrimaryEvent: empty group');
  }
  let best = events[0];
  for (const event of events.slice(1)) {
    if (compareEvents(event, best) < 0) best = event;
  }
  return best;
}

/** Every event in the group except the chosen primary, in display order. */
function orderSubordinates(events: readonly IncidentEvent[], primary: IncidentEvent): IncidentEvent[] {
  return events.filter((e) => e !== primary).slice().sort(compareEvents);
}

/**
 * Partitions a chronologically-ordered event list into timeline groups.
 * Group order follows each group's first appearance in `events` (i.e. still
 * chronological overall); only the events INSIDE a group are reordered by
 * content, per orderSubordinates above.
 */
export function groupTimelineEvents(events: readonly IncidentEvent[]): TimelineGroup[] {
  const order: (string | symbol)[] = [];
  const buckets = new Map<string | symbol, IncidentEvent[]>();
  for (const event of events) {
    const key: string | symbol = event.operationId == null ? Symbol(event.id) : event.operationId;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(event);
  }
  return order.map((key) => {
    const bucketEvents = buckets.get(key)!;
    const primary = selectPrimaryEvent(bucketEvents);
    return {
      operationId: bucketEvents[0].operationId,
      primary,
      subordinates: orderSubordinates(bucketEvents, primary),
    };
  });
}
