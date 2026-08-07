// Pure, in-memory mirror of the get_incident_closure_insights Postgres RPC
// (supabase/migrations/0051_incident_analytics_v2_rpcs.sql). Used only by
// the local/demo repository -- see analyticsSummary.ts's own header for the
// "RPC is the production authority" note, which applies identically here.
//
// Highest-value correctness property in this file, mirroring the RPC
// exactly (see that migration's header, and supabase/tests/
// incident_closure_insights_rpc.sql): structuredClosuresInPeriod is always
// <= totalClosureEventsInPeriod, because the latter is sourced from the
// immutable incidentEvents log (type 'closed' for a full-readiness closure,
// or a 'status_change' event with field 'status'/newValue
// 'partial_readiness' for a partial-readiness one) rather than from
// incidents.closedAt, which a partial-readiness closure never sets at all.
// Comparing structured-closure counts against closedAt-derived numbers was
// tried twice during design and rejected both times -- see the migration
// header for the full reasoning; this file must never regress to that.
import type { AnalyticsFilters } from './analyticsSummary';
import { addDays, jerusalemDateKey, jerusalemMidnightIso, matchesEntityFilters, withinPeriod } from './analyticsSummary';
import type { ConfirmedCause, Incident, IncidentClosureClassification, IncidentEvent, TreatmentOutcome } from './types';

export interface AnalyticsEnumCount<T extends string> {
  value: T;
  count: number;
}

export interface IncidentClosureInsights {
  structuredClosuresInPeriod: number;
  totalClosureEventsInPeriod: number;
  confirmedCauseCounts: AnalyticsEnumCount<ConfirmedCause>[];
  treatmentOutcomeCounts: AnalyticsEnumCount<TreatmentOutcome>[];
  /** Period-scoped, closure-time CAUSE fact -- confirmedCause = 'external'. */
  causeExternalClosedCount: number;
  /** Period-scoped, closure-time TREATMENT attribution fact --
   *  resolutionAttribution = 'external_party_no_details'. A genuinely
   *  different concept from causeExternalClosedCount above (and from
   *  analyticsSummary.ts's externallyHandledOpenCount, which is current-
   *  state, not period-scoped) -- never merged into one number. */
  resolutionAttributionExternalCount: number;
}

function distinctIncidentCountByValue<T extends string>(
  rows: IncidentClosureClassification[],
  pick: (row: IncidentClosureClassification) => T,
): AnalyticsEnumCount<T>[] {
  const byValue = new Map<T, Set<string>>();
  for (const row of rows) {
    const value = pick(row);
    const ids = byValue.get(value) ?? new Set<string>();
    ids.add(row.incidentId);
    byValue.set(value, ids);
  }
  return [...byValue.entries()]
    .map(([value, ids]) => ({ value, count: ids.size }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function computeIncidentClosureInsights(
  incidents: Incident[],
  events: IncidentEvent[],
  closures: IncidentClosureClassification[],
  filters: AnalyticsFilters,
  now: Date,
): IncidentClosureInsights {
  const periodEndIso = now.toISOString();
  const todayKey = jerusalemDateKey(now);
  const periodStartKey = addDays(todayKey, -(filters.periodDays - 1));
  const periodStartIso = jerusalemMidnightIso(periodStartKey);

  const f = incidents.filter((i) => matchesEntityFilters(i, closures, filters));
  const fIds = new Set(f.map((i) => i.id));

  // Row-level re-application of the confirmed-cause/treatment-outcome
  // filter, mirroring migration 0051's closures_in_period CTE fix: fIds
  // membership (via matchesEntityFilters) only proves the incident had A
  // matching closure SOMEWHERE in its history, unbounded by period -- the
  // correct, intentional page-wide entity-selection rule, shared with
  // computeIncidentAnalytics/computeIncidentOpenBacklog and left
  // unchanged. It does NOT prove that a given IN-PERIOD closure row here
  // matches. Without this row-level check, a reopened incident whose only
  // matching closure was an earlier, out-of-period cycle could surface an
  // unrelated, contradicting cause/outcome value in the breakdown below.
  const hasCauseFilter = filters.confirmedCauses !== undefined && filters.confirmedCauses.length > 0;
  const hasOutcomeFilter = filters.treatmentOutcomes !== undefined && filters.treatmentOutcomes.length > 0;
  const closuresInPeriod = closures.filter(
    (c) =>
      fIds.has(c.incidentId) &&
      withinPeriod(c.eventTime, periodStartIso, periodEndIso) &&
      (!hasCauseFilter || filters.confirmedCauses!.includes(c.confirmedCause)) &&
      (!hasOutcomeFilter || filters.treatmentOutcomes!.includes(c.treatmentOutcome)),
  );
  const structuredIncidentIds = new Set(closuresInPeriod.map((c) => c.incidentId));

  // Deliberately NOT re-filtered by confirmedCauses/treatmentOutcomes,
  // unlike closuresInPeriod above: IncidentEvent carries no cause/outcome
  // field at all (a partial-readiness closure is structurally
  // unclassifiable), and this set's sole role is the structured-vs-
  // unstructured coverage denominator the UI's caveat text describes -- it
  // never claims those events share the selected cause/outcome, only that
  // a closing action happened in period for a page-wide-qualifying
  // incident. See migration 0051's matching comment for the full reasoning.
  const closureEventIncidentIds = new Set(
    events
      .filter(
        (e) =>
          fIds.has(e.incidentId) &&
          withinPeriod(e.eventTime, periodStartIso, periodEndIso) &&
          (e.type === 'closed' ||
            (e.type === 'status_change' && e.field === 'status' && e.newValue === 'partial_readiness')),
      )
      .map((e) => e.incidentId),
  );

  const causeExternalClosedCount = new Set(
    closuresInPeriod.filter((c) => c.confirmedCause === 'external').map((c) => c.incidentId),
  ).size;
  const resolutionAttributionExternalCount = new Set(
    closuresInPeriod.filter((c) => c.resolutionAttribution === 'external_party_no_details').map((c) => c.incidentId),
  ).size;

  return {
    structuredClosuresInPeriod: structuredIncidentIds.size,
    totalClosureEventsInPeriod: closureEventIncidentIds.size,
    confirmedCauseCounts: distinctIncidentCountByValue(closuresInPeriod, (c) => c.confirmedCause),
    treatmentOutcomeCounts: distinctIncidentCountByValue(closuresInPeriod, (c) => c.treatmentOutcome),
    causeExternalClosedCount,
    resolutionAttributionExternalCount,
  };
}
