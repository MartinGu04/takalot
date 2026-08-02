// Pure, in-memory mirror of the get_incident_analytics Postgres RPC
// (supabase/migrations/0036_incident_analytics_rpc.sql), used ONLY by the
// local/demo repository -- the Supabase repository calls the real RPC and
// never touches this file. The RPC is the production calculation
// authority; this module exists solely so demo-mode browsing and Vitest
// component tests have something to compute analytics from without a
// database. Both implementations are written against, and tested against,
// the same documented per-metric rules -- see that migration's header
// comment and supabase/tests/incident_analytics_rpc.sql for the
// authoritative spec and its SQL-level test coverage; a change to either
// implementation should prompt a matching review of the other.
import type { Incident, IncidentEvent, Severity, SystemRecord } from './types';
import { isOpen } from './types';
import { localInputToIso } from '../lib/time';

export type AnalyticsPeriodDays = 7 | 30 | 90;

export interface AnalyticsFilters {
  periodDays: AnalyticsPeriodDays;
  systemId?: string;
  locationId?: string;
  severity?: Severity;
}

export interface AnalyticsBucket {
  /** Asia/Jerusalem calendar date the bucket starts on, YYYY-MM-DD. */
  bucketStart: string;
  opened: number;
  closed: number;
}

export interface AnalyticsSystemRow {
  systemId: string;
  systemName: string;
  openedInPeriod: number;
  currentlyOpen: number;
  avgCloseMinutes: number | null;
}

export interface IncidentAnalytics {
  openedInPeriod: number;
  closedInPeriod: number;
  avgCloseMinutes: number | null;
  currentlyOpen: number;
  avgOpenMinutes: number | null;
  reopenedInPeriod: number;
  buckets: AnalyticsBucket[];
  topSystems: AnalyticsSystemRow[];
}

const TZ = 'Asia/Jerusalem';

const jerusalemDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Asia/Jerusalem calendar date (YYYY-MM-DD) an instant falls on. */
function jerusalemDateKey(d: Date): string {
  return jerusalemDateFmt.format(d);
}

/** A UTC-anchored-at-noon Date standing in for a calendar date, used only
 *  for day-of-week / day-arithmetic -- never for real wall-clock display. */
function calendarDate(dateKey: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

function addDays(dateKey: string, days: number): string {
  const d = calendarDate(dateKey);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday (ISO week start) of the week containing this calendar date. */
function isoWeekStart(dateKey: string): string {
  const d = calendarDate(dateKey);
  const dow = d.getUTCDay(); // 0=Sunday..6=Saturday
  const daysSinceMonday = (dow + 6) % 7;
  return addDays(dateKey, -daysSinceMonday);
}

/** The Asia/Jerusalem midnight of this calendar date, as an ISO UTC instant. */
function jerusalemMidnightIso(dateKey: string): string {
  return localInputToIso(`${dateKey}T00:00`);
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function minutesBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000;
}

function withinPeriod(iso: string, periodStartIso: string, periodEndIso: string): boolean {
  return iso >= periodStartIso && iso <= periodEndIso;
}

export function computeIncidentAnalytics(
  incidents: Incident[],
  events: IncidentEvent[],
  systems: SystemRecord[],
  filters: AnalyticsFilters,
  now: Date,
): IncidentAnalytics {
  const periodEndIso = now.toISOString();
  const todayKey = jerusalemDateKey(now);
  const periodStartKey = addDays(todayKey, -(filters.periodDays - 1));
  const periodStartIso = jerusalemMidnightIso(periodStartKey);
  const bucketUnit: 'day' | 'week' = filters.periodDays === 90 ? 'week' : 'day';

  const f = incidents.filter(
    (i) =>
      (filters.systemId === undefined || i.systemId === filters.systemId) &&
      (filters.locationId === undefined || i.locationId === filters.locationId) &&
      (filters.severity === undefined || i.severity === filters.severity),
  );
  const fIds = new Set(f.map((i) => i.id));

  const openedInPeriod = f.filter((i) => withinPeriod(i.discoveredAt, periodStartIso, periodEndIso));
  const closedInPeriod = f.filter((i) => i.closedAt !== null && withinPeriod(i.closedAt, periodStartIso, periodEndIso));
  const currentlyOpenSet = f.filter((i) => isOpen(i.status));
  const reopenedEventsInPeriod = events.filter(
    (e) => e.type === 'reopened' && fIds.has(e.incidentId) && withinPeriod(e.eventTime, periodStartIso, periodEndIso),
  );

  const avgCloseMinutes = avg(closedInPeriod.map((i) => minutesBetween(i.discoveredAt, i.closedAt!)));
  const avgOpenMinutes = avg(currentlyOpenSet.map((i) => Math.max(0, minutesBetween(i.discoveredAt, periodEndIso))));

  // ----- Buckets: zero-filled scaffold, source rows bounded to the exact
  // period window before being grouped -- mirrors the RPC's explicit
  // event-time filter, not just a date-key grouping, so a pre-period event
  // can never leak into a partial first weekly bucket. -----
  const bucketKeys: string[] = [];
  if (bucketUnit === 'day') {
    for (let key = periodStartKey; key <= todayKey; key = addDays(key, 1)) bucketKeys.push(key);
  } else {
    const startWeek = isoWeekStart(periodStartKey);
    const endWeek = isoWeekStart(todayKey);
    for (let key = startWeek; key <= endWeek; key = addDays(key, 7)) bucketKeys.push(key);
  }
  const bucketKeyFor = (iso: string): string => {
    const dateKey = jerusalemDateKey(new Date(iso));
    return bucketUnit === 'day' ? dateKey : isoWeekStart(dateKey);
  };
  const openedByBucket = new Map<string, number>();
  for (const i of openedInPeriod) {
    const key = bucketKeyFor(i.discoveredAt);
    openedByBucket.set(key, (openedByBucket.get(key) ?? 0) + 1);
  }
  const closedByBucket = new Map<string, number>();
  for (const i of closedInPeriod) {
    const key = bucketKeyFor(i.closedAt!);
    closedByBucket.set(key, (closedByBucket.get(key) ?? 0) + 1);
  }
  const buckets: AnalyticsBucket[] = bucketKeys.map((bucketStart) => ({
    bucketStart,
    opened: openedByBucket.get(bucketStart) ?? 0,
    closed: closedByBucket.get(bucketStart) ?? 0,
  }));

  // ----- Top 5 systems: only systems with at least one incident opened in
  // the period; opened desc, currentlyOpen desc, name asc. -----
  const bySystem = new Map<string, { openedInPeriod: number; currentlyOpen: number; closeDurations: number[] }>();
  for (const i of f) {
    const row = bySystem.get(i.systemId) ?? { openedInPeriod: 0, currentlyOpen: 0, closeDurations: [] };
    if (withinPeriod(i.discoveredAt, periodStartIso, periodEndIso)) row.openedInPeriod += 1;
    if (isOpen(i.status)) row.currentlyOpen += 1;
    if (i.closedAt !== null && withinPeriod(i.closedAt, periodStartIso, periodEndIso)) {
      row.closeDurations.push(minutesBetween(i.discoveredAt, i.closedAt));
    }
    bySystem.set(i.systemId, row);
  }
  const systemNameOf = (id: string) => systems.find((s) => s.id === id)?.name ?? '—';
  const topSystems: AnalyticsSystemRow[] = [...bySystem.entries()]
    .filter(([, row]) => row.openedInPeriod > 0)
    .map(([systemId, row]) => ({
      systemId,
      systemName: systemNameOf(systemId),
      openedInPeriod: row.openedInPeriod,
      currentlyOpen: row.currentlyOpen,
      avgCloseMinutes: avg(row.closeDurations),
    }))
    .sort(
      (a, b) =>
        b.openedInPeriod - a.openedInPeriod ||
        b.currentlyOpen - a.currentlyOpen ||
        a.systemName.localeCompare(b.systemName),
    )
    .slice(0, 5);

  return {
    openedInPeriod: openedInPeriod.length,
    closedInPeriod: closedInPeriod.length,
    avgCloseMinutes,
    currentlyOpen: currentlyOpenSet.length,
    avgOpenMinutes,
    reopenedInPeriod: new Set(reopenedEventsInPeriod.map((e) => e.incidentId)).size,
    buckets,
    topSystems,
  };
}
