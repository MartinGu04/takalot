// Deterministic, presentation-only classification of a timeline event's
// EventType into (a) a small, muted color family and (b) whether it's
// significant enough for a rich multi-line card vs. a single compact
// inline row. Isolated on purpose: this file decides WHICH bucket an event
// falls into, never how a bucket is drawn (see Timeline.tsx for the actual
// marker/icon classes) and never touches event content itself.
import type { EventType } from './types';

export type TimelineVisualKind =
  | 'open'
  | 'update'
  | 'status'
  | 'report'
  | 'closed'
  | 'reopened'
  | 'cancelled'
  | 'neutral';

const KIND_BY_TYPE: Partial<Record<EventType, TimelineVisualKind>> = {
  created: 'open',
  update: 'update',
  status_change: 'status',
  reported_to_ops_change: 'report',
  reported_to_ops_room: 'report',
  reported_to_ops_communications: 'report',
  closed: 'closed',
  reopened: 'reopened',
  cancelled: 'cancelled',
};

/** Every EventType not explicitly listed above (severity/impact/assignment/
 *  deadline changes, acknowledged, follow_up_completed, correction,
 *  cause_assessment_changed, severity_assessed, status_check_changed,
 *  handover_*) falls back to 'neutral' -- a minor audit delta with no
 *  dedicated color of its own. */
export function timelineVisualKind(type: EventType): TimelineVisualKind {
  return KIND_BY_TYPE[type] ?? 'neutral';
}

/** The incident's own lifecycle, plus the two event types that always carry
 *  substantial free-text/structured content (a treatment update's own
 *  fields; a correction's persisted note) -- these get a rich card. Every
 *  other type is a single-field delta and renders as a compact row. */
const RICH_TYPES = new Set<EventType>(['created', 'closed', 'reopened', 'cancelled', 'update', 'correction']);

export function isRichTimelineEvent(type: EventType): boolean {
  return RICH_TYPES.has(type);
}
