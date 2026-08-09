// Pure, in-memory mirror of getAnalyticsTrendBucketIncidents (see
// src/data/repository.ts and supabaseRepository.ts) -- used only by the
// local/demo repository. Answers "which incidents make up this one trend-
// chart bucket," for the click-to-drill-down affordance on
// IncidentTrendChart. Bounded to LIMIT_PER_SECTION rows per section, the
// same cap the Supabase implementation applies via `.limit()` -- a single
// day/week bucket is never expected to hold more than that in practice, and
// this deliberately never becomes a path for pulling unbounded incident
// history into the browser.
//
// Correctness is entirely inherited from analyticsSummary.ts's own
// matchesEntityFilters (the exact page-wide entity filter every analytics
// module already shares) and bucketKeyOf (the exact bucket-grouping rule
// the trend chart's own buckets are built from) -- this file adds no new
// filtering concept of its own, specifically so the drill-down list can
// never disagree with the chart bar the user clicked.
import { bucketKeyOf, matchesEntityFilters, type AnalyticsBucketUnit, type AnalyticsEntityFilters } from './analyticsSummary';
import type { Incident, IncidentClosureClassification, IncidentSummary } from './types';

export const TREND_BUCKET_DRILLDOWN_LIMIT = 20;

export interface TrendBucketIncidents {
  opened: IncidentSummary[];
  closed: IncidentSummary[];
}

function toSummary(i: Incident): IncidentSummary {
  return {
    id: i.id,
    number: i.number,
    severity: i.severity,
    status: i.status,
    systemId: i.systemId,
    locationId: i.locationId,
    description: i.description,
  };
}

export function computeTrendBucketIncidents(
  incidents: Incident[],
  closures: IncidentClosureClassification[],
  bucketStart: string,
  bucketUnit: AnalyticsBucketUnit,
  filters: AnalyticsEntityFilters,
): TrendBucketIncidents {
  const f = incidents.filter((i) => matchesEntityFilters(i, closures, filters));

  // Chronological within the bucket (matches the Supabase implementation's
  // explicit .order()) -- deterministic display order, not left to
  // whatever order the source array happened to arrive in.
  const opened = f
    .filter((i) => bucketKeyOf(i.discoveredAt, bucketUnit) === bucketStart)
    .sort((a, b) => a.discoveredAt.localeCompare(b.discoveredAt))
    .slice(0, TREND_BUCKET_DRILLDOWN_LIMIT)
    .map(toSummary);
  const closed = f
    .filter((i) => i.closedAt !== null && bucketKeyOf(i.closedAt, bucketUnit) === bucketStart)
    .sort((a, b) => a.closedAt!.localeCompare(b.closedAt!))
    .slice(0, TREND_BUCKET_DRILLDOWN_LIMIT)
    .map(toSummary);

  return { opened, closed };
}
