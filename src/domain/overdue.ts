// Overdue state is always calculated, never stored or manually selected.
import type { Incident } from './types';
import { isOpen } from './types';

export function isOverdue(incident: Incident, now: Date): boolean {
  if (!isOpen(incident.status)) return false;
  if (!incident.nextUpdateDue) return false;
  return new Date(incident.nextUpdateDue).getTime() < now.getTime();
}

export function overdueMinutes(incident: Incident, now: Date): number {
  if (!incident.nextUpdateDue) return 0;
  return Math.floor((now.getTime() - new Date(incident.nextUpdateDue).getTime()) / 60000);
}

/** Human Hebrew phrasing, e.g. "העדכון באיחור של 18 דקות". */
export function overdueText(incident: Incident, now: Date): string {
  const minutes = overdueMinutes(incident, now);
  if (minutes < 1) return 'העדכון באיחור';
  if (minutes < 60) return `העדכון באיחור של ${minutes} דקות`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) {
    return rem > 0
      ? `העדכון באיחור של ${hours} שעות ו־${rem} דקות`
      : `העדכון באיחור של ${hours} שעות`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0
    ? `העדכון באיחור של ${days} ימים ו־${remHours} שעות`
    : `העדכון באיחור של ${days} ימים`;
}

/**
 * Default active-incident priority order:
 * 1. critical/high overdue
 * 2. other overdue (medium/low)
 * 3. remaining critical/high (not overdue)
 * 4. remaining active (medium/low, not overdue)
 */
export function priorityRank(incident: Incident, now: Date): number {
  const overdue = isOverdue(incident, now);
  const highSeverity = incident.severity === 'critical' || incident.severity === 'high';
  if (overdue && highSeverity) return 0;
  if (overdue) return 1;
  if (highSeverity) return 2;
  return 3;
}

/**
 * Sorts by the operational priority tier above; within a tier, newest
 * discovery time first (falling back to newest creation time to break an
 * exact tie). Opening/discovery time is only ever a tie-breaker inside an
 * already-established severity/overdue tier -- never the sole ordering rule.
 */
export function sortByPriority(incidents: Incident[], now: Date): Incident[] {
  return [...incidents].sort((a, b) => {
    const ra = priorityRank(a, now);
    const rb = priorityRank(b, now);
    if (ra !== rb) return ra - rb;
    const da = new Date(a.discoveredAt).getTime();
    const db = new Date(b.discoveredAt).getTime();
    if (da !== db) return db - da;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}
