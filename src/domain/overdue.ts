// Active-incident priority ordering. The next-update-ETA concept was
// removed from the active product (creation/update/reopen no longer ask
// for it, and no dashboard behavior is driven by it) -- severity is now
// the sole ranking signal. No replacement SLA (e.g. "not updated in 24h")
// is introduced here.
import type { Incident } from './types';

/**
 * Default active-incident priority order:
 * 1. critical/high severity
 * 2. everything else
 */
export function priorityRank(incident: Incident): number {
  const highSeverity = incident.severity === 'critical' || incident.severity === 'high';
  return highSeverity ? 0 : 1;
}

/**
 * Sorts by the operational priority tier above; within a tier, newest
 * discovery time first (falling back to newest creation time to break an
 * exact tie). Opening/discovery time is only ever a tie-breaker inside an
 * already-established severity tier -- never the sole ordering rule.
 */
export function sortByPriority(incidents: Incident[]): Incident[] {
  return [...incidents].sort((a, b) => {
    const ra = priorityRank(a);
    const rb = priorityRank(b);
    if (ra !== rb) return ra - rb;
    const da = new Date(a.discoveredAt).getTime();
    const db = new Date(b.discoveredAt).getTime();
    if (da !== db) return db - da;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}
