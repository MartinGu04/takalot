// Pure, in-memory mirror of the get_incident_analytics_v2 Postgres RPC
// (supabase/migrations/0051_incident_analytics_v2_rpcs.sql), used ONLY by
// the local/demo repository -- the Supabase repository calls the real RPC
// and never touches this file. The RPC is the production calculation
// authority; this module exists solely so demo-mode browsing and Vitest
// component tests have something to compute analytics from without a
// database. Both implementations are written against, and tested against,
// the same documented per-metric rules -- see that migration's header
// comment and supabase/tests/incident_analytics_v2_rpc.sql for the
// authoritative spec and its SQL-level test coverage; a change to either
// implementation should prompt a matching review of the other.
//
// v1.4.0 note: this file also hosts the shared filter/median helpers used by
// its two siblings, analyticsOpenBacklog.ts and analyticsClosureInsights.ts
// (each mirroring one of the other two v1.4.0 RPCs) -- kept together here,
// not split further, mirroring the backend's own decision to extend this
// RPC's logic under a new name rather than fragment it (see the migration
// header for the full "why not 6 RPCs" reasoning). The original
// get_incident_analytics (4-parameter, pre-v1.4.0) RPC is left untouched in
// the database as a compatibility path and has no JS-side mirror of its own
// beyond what already existed before this file changed shape.
import type {
  ConfirmedCause,
  Incident,
  IncidentClosureClassification,
  IncidentDomain,
  IncidentEvent,
  LocationRecord,
  Severity,
  SystemRecord,
  TreatmentOutcome,
} from './types';
import { isOpen, SEVERITY_ORDER } from './types';
import { CONFIRMED_CAUSE_ORDER, INCIDENT_DOMAIN_ORDER, TREATMENT_OUTCOME_ORDER } from './labels';
import { localInputToIso } from '../lib/time';

export type AnalyticsPeriodDays = 7 | 30 | 90;

/** Shared, NOT period-bound filter shape -- used as-is by
 *  computeIncidentOpenBacklog (which has no period concept at all) and
 *  extended with periodDays below for the two period-bound RPCs' mirrors. */
export interface AnalyticsEntityFilters {
  systemId?: string;
  locationId?: string;
  /** Multi-select (was a single Severity through v1.3.0) -- empty/undefined
   *  means no severity filter, matching the RPC's `p_severities is null`. */
  severities?: Severity[];
  domains?: IncidentDomain[];
  /** Matches `reportedDomain === null` ("לא סווg") -- a distinct, explicit
   *  chip, never folded into `domains` itself (there is no IncidentDomain
   *  value for "unclassified"). */
  includeUnclassifiedDomain?: boolean;
  /** Page-wide: narrows to incidents with at least one closure record
   *  (any cycle, unbounded by period -- see the migration header for why)
   *  matching every provided cause/outcome constraint on the SAME closure
   *  row. Consequence: an incident with no closure record at all (routinely
   *  true for any currently-open incident) never matches once either of
   *  these is set. */
  confirmedCauses?: ConfirmedCause[];
  treatmentOutcomes?: TreatmentOutcome[];
}

export interface AnalyticsFilters extends AnalyticsEntityFilters {
  periodDays: AnalyticsPeriodDays;
}

function sortByOrder<T>(values: T[] | undefined, order: readonly T[]): T[] | undefined {
  if (!values || values.length === 0) return undefined;
  return [...values].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/**
 * Normalizes every filter array to its fixed enum display order (and empty
 * arrays to `undefined`) before the filters reach a TanStack Query key or an
 * RPC call. React Query v5 hashes query keys structurally, but that hash is
 * still sensitive to ARRAY ORDER -- `{severities:['high','critical']}` and
 * `{severities:['critical','high']}` are the same filter to a user (picked
 * via unordered chips) but would otherwise miss each other's cache entry and
 * could even both be "the current filter" simultaneously in different tabs
 * of the same session. Canonicalizing before the key is built collapses
 * both into one cache entry.
 */
export function canonicalizeAnalyticsFilters<F extends AnalyticsEntityFilters>(filters: F): F {
  return {
    ...filters,
    severities: sortByOrder(filters.severities, SEVERITY_ORDER),
    domains: sortByOrder(filters.domains, INCIDENT_DOMAIN_ORDER),
    confirmedCauses: sortByOrder(filters.confirmedCauses, CONFIRMED_CAUSE_ORDER),
    treatmentOutcomes: sortByOrder(filters.treatmentOutcomes, TREATMENT_OUTCOME_ORDER),
  };
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
  medianCloseMinutes: number | null;
}

export interface AnalyticsLocationRow {
  locationId: string;
  locationName: string;
  openedInPeriod: number;
  currentlyOpen: number;
  medianCloseMinutes: number | null;
}

export interface IncidentAnalytics {
  openedInPeriod: number;
  closedInPeriod: number;
  /** Primary resolution-time metric as of v1.4.0 -- see AnalyticsKpiCard.
   *  `null` (never `0`) when the closed-in-period set is empty. */
  medianCloseMinutes: number | null;
  /** Secondary/tooltip-only context alongside medianCloseMinutes -- no
   *  longer the page's headline resolution-time number. */
  avgCloseMinutes: number | null;
  currentlyOpen: number;
  avgOpenMinutes: number | null;
  reopenedInPeriod: number;
  /** Current-state (NOT period-bound), mirroring currentlyOpen's own
   *  semantics -- currently-open incidents in the filtered set with an
   *  external handling party recorded. A different concept from
   *  confirmedCause = 'external' (closure-time CAUSE) and from
   *  resolutionAttributionExternalCount (closure-time TREATMENT
   *  attribution, in analyticsClosureInsights.ts) -- kept separate
   *  throughout, never merged. */
  externallyHandledOpenCount: number;
  buckets: AnalyticsBucket[];
  topSystems: AnalyticsSystemRow[];
  topLocations: AnalyticsLocationRow[];
}

const TZ = 'Asia/Jerusalem';

const jerusalemDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Asia/Jerusalem calendar date (YYYY-MM-DD) an instant falls on. */
export function jerusalemDateKey(d: Date): string {
  return jerusalemDateFmt.format(d);
}

/** A UTC-anchored-at-noon Date standing in for a calendar date, used only
 *  for day-of-week / day-arithmetic -- never for real wall-clock display. */
function calendarDate(dateKey: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

export function addDays(dateKey: string, days: number): string {
  const d = calendarDate(dateKey);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday (ISO week start) of the week containing this calendar date. */
export function isoWeekStart(dateKey: string): string {
  const d = calendarDate(dateKey);
  const dow = d.getUTCDay(); // 0=Sunday..6=Saturday
  const daysSinceMonday = (dow + 6) % 7;
  return addDays(dateKey, -daysSinceMonday);
}

/** The Asia/Jerusalem midnight of this calendar date, as an ISO UTC instant. */
export function jerusalemMidnightIso(dateKey: string): string {
  return localInputToIso(`${dateKey}T00:00`);
}

export type AnalyticsBucketUnit = 'day' | 'week';

/** The trend chart's own bucket-granularity rule: daily buckets for 7/30-day
 *  periods, weekly (ISO week, Monday start) for 90-day -- otherwise a
 *  90-day trend would render ~90 individual bars. Centralized here (rather
 *  than re-deriving `periodDays === 90` at each call site) so every
 *  consumer -- the trend computation itself, and the bucket drill-down,
 *  which must resolve the exact same bucket a chart bar represents --
 *  agrees by construction, never by convention. */
export function bucketUnitForPeriod(periodDays: AnalyticsPeriodDays): AnalyticsBucketUnit {
  return periodDays === 90 ? 'week' : 'day';
}

/** The bucket key (day: its own YYYY-MM-DD; week: the Monday of its ISO
 *  week) that a given instant's Asia/Jerusalem calendar date falls into --
 *  the exact grouping rule AnalyticsBucket.bucketStart values are built
 *  from below, and the one the bucket drill-down (analyticsTrendDrilldown.ts)
 *  re-applies to decide whether a specific incident belongs to a clicked
 *  bucket. Keeping this in one exported function is what guarantees the
 *  drill-down can never disagree with the chart it's drilling into. */
export function bucketKeyOf(iso: string, bucketUnit: AnalyticsBucketUnit): string {
  const dateKey = jerusalemDateKey(new Date(iso));
  return bucketUnit === 'day' ? dateKey : isoWeekStart(dateKey);
}

export function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Linear-interpolation median, matching Postgres's
 *  `percentile_cont(0.5) within group (order by ...)` exactly: the average
 *  of the two middle values for an even-length set, the single middle value
 *  for an odd-length set. `null` (never `0`) for an empty set, mirroring
 *  avg()'s own null-vs-zero discipline. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function minutesBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000;
}

export function withinPeriod(iso: string, periodStartIso: string, periodEndIso: string): boolean {
  return iso >= periodStartIso && iso <= periodEndIso;
}

/** Shared entity-filter predicate used by all three v1.4.0 analytics
 *  compute functions -- mirrors the `f` CTE every new RPC builds from
 *  (see 0051's migration header), including the page-wide, unbounded-by-
 *  period confirmed-cause/treatment-outcome EXISTS semantics. */
export function matchesEntityFilters(
  incident: Incident,
  closures: IncidentClosureClassification[],
  filters: AnalyticsEntityFilters,
): boolean {
  if (filters.systemId !== undefined && incident.systemId !== filters.systemId) return false;
  if (filters.locationId !== undefined && incident.locationId !== filters.locationId) return false;

  if (filters.severities && filters.severities.length > 0 && !filters.severities.includes(incident.severity)) {
    return false;
  }

  const hasDomainFilter = (filters.domains && filters.domains.length > 0) || filters.includeUnclassifiedDomain === true;
  if (hasDomainFilter) {
    const matchesDomain =
      (filters.domains !== undefined && incident.reportedDomain !== null && filters.domains.includes(incident.reportedDomain)) ||
      (filters.includeUnclassifiedDomain === true && incident.reportedDomain === null);
    if (!matchesDomain) return false;
  }

  const hasCauseFilter = filters.confirmedCauses !== undefined && filters.confirmedCauses.length > 0;
  const hasOutcomeFilter = filters.treatmentOutcomes !== undefined && filters.treatmentOutcomes.length > 0;
  if (hasCauseFilter || hasOutcomeFilter) {
    const matches = closures.some(
      (c) =>
        c.incidentId === incident.id &&
        (!hasCauseFilter || filters.confirmedCauses!.includes(c.confirmedCause)) &&
        (!hasOutcomeFilter || filters.treatmentOutcomes!.includes(c.treatmentOutcome)),
    );
    if (!matches) return false;
  }

  return true;
}

export function computeIncidentAnalytics(
  incidents: Incident[],
  events: IncidentEvent[],
  systems: SystemRecord[],
  locations: LocationRecord[],
  closures: IncidentClosureClassification[],
  filters: AnalyticsFilters,
  now: Date,
): IncidentAnalytics {
  const periodEndIso = now.toISOString();
  const todayKey = jerusalemDateKey(now);
  const periodStartKey = addDays(todayKey, -(filters.periodDays - 1));
  const periodStartIso = jerusalemMidnightIso(periodStartKey);
  const bucketUnit = bucketUnitForPeriod(filters.periodDays);

  const f = incidents.filter((i) => matchesEntityFilters(i, closures, filters));
  const fIds = new Set(f.map((i) => i.id));

  const openedInPeriod = f.filter((i) => withinPeriod(i.discoveredAt, periodStartIso, periodEndIso));
  const closedInPeriod = f.filter((i) => i.closedAt !== null && withinPeriod(i.closedAt, periodStartIso, periodEndIso));
  const currentlyOpenSet = f.filter((i) => isOpen(i.status));
  const reopenedEventsInPeriod = events.filter(
    (e) => e.type === 'reopened' && fIds.has(e.incidentId) && withinPeriod(e.eventTime, periodStartIso, periodEndIso),
  );

  const closeDurations = closedInPeriod.map((i) => minutesBetween(i.discoveredAt, i.closedAt!));
  const medianCloseMinutes = median(closeDurations);
  const avgCloseMinutes = avg(closeDurations);
  const avgOpenMinutes = avg(currentlyOpenSet.map((i) => Math.max(0, minutesBetween(i.discoveredAt, periodEndIso))));
  const externallyHandledOpenCount = currentlyOpenSet.filter((i) => i.externalHandlerName !== null).length;

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
  const openedByBucket = new Map<string, number>();
  for (const i of openedInPeriod) {
    const key = bucketKeyOf(i.discoveredAt, bucketUnit);
    openedByBucket.set(key, (openedByBucket.get(key) ?? 0) + 1);
  }
  const closedByBucket = new Map<string, number>();
  for (const i of closedInPeriod) {
    const key = bucketKeyOf(i.closedAt!, bucketUnit);
    closedByBucket.set(key, (closedByBucket.get(key) ?? 0) + 1);
  }
  const buckets: AnalyticsBucket[] = bucketKeys.map((bucketStart) => ({
    bucketStart,
    opened: openedByBucket.get(bucketStart) ?? 0,
    closed: closedByBucket.get(bucketStart) ?? 0,
  }));

  // ----- Top 5 systems/locations: only entities with at least one incident
  // opened in the period; opened desc, currentlyOpen desc, name asc. Duration
  // column is MEDIAN as of v1.4.0 (was average) -- see AnalyticsKpiCard/
  // RankingList; no per-row average is exposed any more. -----
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
      medianCloseMinutes: median(row.closeDurations),
    }))
    .sort(
      (a, b) =>
        b.openedInPeriod - a.openedInPeriod ||
        b.currentlyOpen - a.currentlyOpen ||
        a.systemName.localeCompare(b.systemName),
    )
    .slice(0, 5);

  const byLocation = new Map<string, { openedInPeriod: number; currentlyOpen: number; closeDurations: number[] }>();
  for (const i of f) {
    const row = byLocation.get(i.locationId) ?? { openedInPeriod: 0, currentlyOpen: 0, closeDurations: [] };
    if (withinPeriod(i.discoveredAt, periodStartIso, periodEndIso)) row.openedInPeriod += 1;
    if (isOpen(i.status)) row.currentlyOpen += 1;
    if (i.closedAt !== null && withinPeriod(i.closedAt, periodStartIso, periodEndIso)) {
      row.closeDurations.push(minutesBetween(i.discoveredAt, i.closedAt));
    }
    byLocation.set(i.locationId, row);
  }
  const locationNameOf = (id: string) => locations.find((l) => l.id === id)?.name ?? '—';
  const topLocations: AnalyticsLocationRow[] = [...byLocation.entries()]
    .filter(([, row]) => row.openedInPeriod > 0)
    .map(([locationId, row]) => ({
      locationId,
      locationName: locationNameOf(locationId),
      openedInPeriod: row.openedInPeriod,
      currentlyOpen: row.currentlyOpen,
      medianCloseMinutes: median(row.closeDurations),
    }))
    .sort(
      (a, b) =>
        b.openedInPeriod - a.openedInPeriod ||
        b.currentlyOpen - a.currentlyOpen ||
        a.locationName.localeCompare(b.locationName),
    )
    .slice(0, 5);

  return {
    openedInPeriod: openedInPeriod.length,
    closedInPeriod: closedInPeriod.length,
    medianCloseMinutes,
    avgCloseMinutes,
    currentlyOpen: currentlyOpenSet.length,
    avgOpenMinutes,
    reopenedInPeriod: new Set(reopenedEventsInPeriod.map((e) => e.incidentId)).size,
    externallyHandledOpenCount,
    buckets,
    topSystems,
    topLocations,
  };
}
