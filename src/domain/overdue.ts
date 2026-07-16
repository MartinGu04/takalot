// Overdue state is always calculated, never stored or manually selected.
import type { Incident, Severity } from './types';
import { SEVERITY_ORDER, isOpen } from './types';

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

const severityRank = (s: Severity) => SEVERITY_ORDER.indexOf(s);

/**
 * Dashboard priority sort:
 * 1. critical overdue, 2. high overdue, 3. other overdue,
 * 4. critical not overdue, 5. high not overdue,
 * 6. the rest by nearest next update.
 */
export function priorityRank(incident: Incident, now: Date): number {
  const overdue = isOverdue(incident, now);
  const sev = incident.severity;
  if (overdue && sev === 'critical') return 0;
  if (overdue && sev === 'high') return 1;
  if (overdue) return 2;
  if (sev === 'critical') return 3;
  if (sev === 'high') return 4;
  return 5;
}

export function sortByPriority(incidents: Incident[], now: Date): Incident[] {
  return [...incidents].sort((a, b) => {
    const ra = priorityRank(a, now);
    const rb = priorityRank(b, now);
    if (ra !== rb) return ra - rb;
    if (ra <= 2) {
      // among overdue: most overdue first, then severity
      const oa = overdueMinutes(a, now);
      const ob = overdueMinutes(b, now);
      if (oa !== ob) return ob - oa;
      return severityRank(a.severity) - severityRank(b.severity);
    }
    // among not overdue: nearest next update first; no deadline goes last
    const da = a.nextUpdateDue ? new Date(a.nextUpdateDue).getTime() : Infinity;
    const db = b.nextUpdateDue ? new Date(b.nextUpdateDue).getTime() : Infinity;
    if (da !== db) return da - db;
    return severityRank(a.severity) - severityRank(b.severity);
  });
}
