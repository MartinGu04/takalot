// Pure, in-memory mirror of the get_incident_open_backlog Postgres RPC
// (supabase/migrations/0051_incident_analytics_v2_rpcs.sql). Used only by
// the local/demo repository -- see analyticsSummary.ts's own header for the
// "RPC is the production authority" note, which applies identically here.
//
// Deliberately no periodDays concept: the age of the CURRENT open backlog
// is not period-bound, matching avgOpenMinutes'/currentlyOpen's own
// semantics in analyticsSummary.ts.
import type { AnalyticsEntityFilters } from './analyticsSummary';
import { matchesEntityFilters } from './analyticsSummary';
import type { Incident, IncidentClosureClassification } from './types';
import { isOpen } from './types';

export type AnalyticsBacklogBandKey = 'lt_1d' | '1_3d' | '3_7d' | '7_14d' | 'gt_14d';

export interface AnalyticsBacklogBand {
  band: AnalyticsBacklogBandKey;
  count: number;
}

export interface IncidentOpenBacklog {
  currentlyOpen: number;
  /** Always all 5 bands, zero-filled -- never a sparse array, matching the
   *  RPC's own zero-fill convention for the trend chart's buckets. */
  bands: AnalyticsBacklogBand[];
}

/** Days since discovery, clamped to >=0 (defends against the same clock-skew
 *  case avgOpenMinutes already guards in analyticsSummary.ts -- a future-
 *  dated discoveredAt must never produce a negative age). */
function ageDaysOf(incident: Incident, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(incident.discoveredAt).getTime()) / 86_400_000);
}

export function computeIncidentOpenBacklog(
  incidents: Incident[],
  closures: IncidentClosureClassification[],
  filters: AnalyticsEntityFilters,
  now: Date,
): IncidentOpenBacklog {
  const f = incidents.filter((i) => isOpen(i.status) && matchesEntityFilters(i, closures, filters));
  const ages = f.map((i) => ageDaysOf(i, now));

  const bands: AnalyticsBacklogBand[] = [
    { band: 'lt_1d', count: ages.filter((a) => a < 1).length },
    { band: '1_3d', count: ages.filter((a) => a >= 1 && a < 3).length },
    { band: '3_7d', count: ages.filter((a) => a >= 3 && a < 7).length },
    { band: '7_14d', count: ages.filter((a) => a >= 7 && a < 14).length },
    { band: 'gt_14d', count: ages.filter((a) => a >= 14).length },
  ];

  return { currentlyOpen: f.length, bands };
}
