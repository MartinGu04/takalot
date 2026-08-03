// Pure "מצב נוכחי" (current-status) derivation -- kept separate from the
// page component so the actual business rules (what counts as urgent, what
// belongs in the general open list, what counts as recently closed) are
// unit-testable without rendering the app.
import type { Incident } from './types';
import { isOpen } from './types';
import { sortByPriority } from './overdue';

export interface DashboardSummary {
  open: Incident[];
  criticalOrHigh: Incident[];
  /** "דורש טיפול עכשיו" -- open AND critical severity. Priority-sorted.
   *  The next-update-ETA concept (formerly a second qualifying condition
   *  here, "overdue") was removed from the active product -- severity is
   *  now the sole qualifying signal. */
  needsAttention: Incident[];
  /** "תקלות פתוחות" -- every other open incident, priority-sorted. Excludes
   *  anything already in `needsAttention` so no incident renders as a full
   *  card in two sections at once. */
  openRest: Incident[];
  /** "נסגרו לאחרונה" -- the most recently closed incidents ONLY (status ===
   *  'closed'). Cancelled incidents are a different outcome -- no root
   *  cause/resolution, never "resolved" -- so they never belong in this
   *  home-page section, even though they're just as terminal and still show
   *  up in the archive alongside closed incidents. Newest closedAt first,
   *  capped at `limit`. */
  recentTerminal: Incident[];
}

/** The moment an incident actually reached its terminal state: closedAt for
 *  a closed incident, cancelledAt for a cancelled one. Never both set. */
export function terminalAt(incident: Incident): string | null {
  return incident.status === 'cancelled' ? incident.cancelledAt : incident.closedAt;
}

export function summarizeDashboard(incidents: Incident[], recentTerminalLimit = 5): DashboardSummary {
  const open = incidents.filter((i) => isOpen(i.status));
  const criticalOrHigh = open.filter((i) => i.severity === 'critical' || i.severity === 'high');

  const needsAttention = sortByPriority(open.filter((i) => i.severity === 'critical'));
  const needsAttentionIds = new Set(needsAttention.map((i) => i.id));
  const openRest = sortByPriority(open.filter((i) => !needsAttentionIds.has(i.id)));

  const recentTerminal = incidents
    .filter((i) => i.status === 'closed')
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
    .slice(0, recentTerminalLimit);

  return { open, criticalOrHigh, needsAttention, openRest, recentTerminal };
}
