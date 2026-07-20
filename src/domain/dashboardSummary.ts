// Pure "מצב נוכחי" (current-status) derivation -- kept separate from the
// page component so the actual business rules (what counts as urgent, what
// belongs in the general open list, what counts as recently closed) are
// unit-testable without rendering the app.
import type { Incident } from './types';
import { isOpen } from './types';
import { isOverdue, sortByPriority } from './overdue';

export interface DashboardSummary {
  open: Incident[];
  overdue: Incident[];
  criticalOrHigh: Incident[];
  /** "דורש טיפול עכשיו" -- open AND (critical severity OR overdue). High
   *  severity alone does not qualify (that's the separate criticalOrHigh
   *  stat). Priority-sorted. */
  needsAttention: Incident[];
  /** "תקלות פתוחות" -- every other open incident, priority-sorted. Excludes
   *  anything already in `needsAttention` so no incident renders as a full
   *  card in two sections at once. */
  openRest: Incident[];
  /** "נסגרו לאחרונה" -- the most recently closed incidents, newest first,
   *  capped at `limit`. */
  recentlyClosed: Incident[];
}

export function summarizeDashboard(incidents: Incident[], now: Date, recentlyClosedLimit = 5): DashboardSummary {
  const open = incidents.filter((i) => isOpen(i.status));
  const overdue = open.filter((i) => isOverdue(i, now));
  const criticalOrHigh = open.filter((i) => i.severity === 'critical' || i.severity === 'high');

  const needsAttention = sortByPriority(
    open.filter((i) => i.severity === 'critical' || isOverdue(i, now)),
    now,
  );
  const needsAttentionIds = new Set(needsAttention.map((i) => i.id));
  const openRest = sortByPriority(
    open.filter((i) => !needsAttentionIds.has(i.id)),
    now,
  );

  const recentlyClosed = incidents
    .filter((i) => i.status === 'closed')
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
    .slice(0, recentlyClosedLimit);

  return { open, overdue, criticalOrHigh, needsAttention, openRest, recentlyClosed };
}
