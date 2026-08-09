// TanStack Query hooks over the repository abstraction.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRepository } from './index';
import {
  AppError,
  type AnalyticsBucketUnit,
  type AnalyticsEntityFilters,
  type AnalyticsFilters,
  type AnalyticsModuleKey,
  type AuditFilters,
  type IncidentFilters,
  type IncidentSort,
} from './repository';
import type { IncidentDomain } from '../domain/types';
import { canonicalizeAnalyticsFilters } from '../domain/analyticsSummary';
import { useAuth, useSession } from '../auth/AuthContext';
import { useToast } from '../components/ui';

const repo = () => getRepository();

export function useProfiles() {
  const session = useSession();
  return useQuery({ queryKey: ['profiles'], queryFn: () => repo().listProfiles(session) });
}

export function useSystems() {
  return useQuery({ queryKey: ['systems'], queryFn: () => repo().listSystems() });
}

export function useLocations() {
  return useQuery({ queryKey: ['locations'], queryFn: () => repo().listLocations() });
}

export function useIncidents(filters: IncidentFilters = {}, sort: IncidentSort = 'priority') {
  const session = useSession();
  return useQuery({
    queryKey: ['incidents', filters, sort],
    queryFn: () => repo().listIncidents(session, filters, sort),
    refetchInterval: 60_000, // keep overdue states fresh while the page is open
    // Every filter/search change produces a new query key. Without this, each
    // one would be treated as a brand-new, uncached query — isLoading would
    // flip true and the page's "if (isLoading) return <Spinner/>" branch would
    // replace the whole tree (including the filter inputs) while it resolves,
    // destroying and recreating the input DOM node and dropping focus.
    // Keeping the previous page's data visible during the refetch avoids that.
    placeholderData: keepPreviousData,
  });
}

/**
 * Total closed-incident count. Keyed under the 'incidents' prefix on purpose:
 * useAppMutation's default invalidation list contains ['incidents'], and
 * TanStack Query matches keys by prefix -- so closing, reopening, or
 * cancelling an incident refreshes this count with no extra wiring.
 */
export function useClosedIncidentCount() {
  const session = useSession();
  return useQuery({
    queryKey: ['incidents', 'closed-count'],
    queryFn: () => repo().countClosedIncidents(session),
  });
}

/** KPIs/chart/top-systems for the ניתוחים (analytics) page. Query key
 *  varies structurally with `filters` (a plain object of primitives), so
 *  TanStack Query treats a filter/period change as a distinct cache entry
 *  with no extra memoization needed. placeholderData keeps the previous
 *  numbers on screen during a filter change instead of flashing a loading
 *  state, the same reasoning as useIncidents. */
export function useIncidentAnalytics(filters: AnalyticsFilters) {
  const session = useSession();
  const canonical = canonicalizeAnalyticsFilters(filters);
  return useQuery({
    queryKey: ['analytics', canonical],
    queryFn: () => repo().getIncidentAnalytics(session, canonical),
    placeholderData: keepPreviousData,
  });
}

/** Open-incident age distribution for the ניתוחים page's backlog module.
 *  `entityFilters` deliberately excludes periodDays -- backlog age is not
 *  period-bound, matching getIncidentAnalytics's own currentlyOpen/
 *  avgOpenMinutes semantics, so a period change never refetches this. The
 *  `trend`/`topSystems`/`topLocations` module toggles have no equivalent
 *  hook of their own: their data already arrives inside
 *  useIncidentAnalytics's always-fetched response (see ReportsPage), so
 *  hiding those modules only gates rendering, never the request -- this
 *  hook and useIncidentClosureInsights below are the two genuinely
 *  skippable fetches (see the RPC-architecture note in
 *  supabase/migrations/0051_incident_analytics_v2_rpcs.sql). */
export function useIncidentOpenBacklog(entityFilters: AnalyticsEntityFilters, options: { enabled?: boolean } = {}) {
  const session = useSession();
  const canonical = canonicalizeAnalyticsFilters(entityFilters);
  return useQuery({
    queryKey: ['analyticsOpenBacklog', canonical],
    queryFn: () => repo().getIncidentOpenBacklog(session, canonical),
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
  });
}

/** Confirmed-cause/treatment-outcome breakdown and closure-scoped external-
 *  involvement counts. `enabled` should be
 *  `visibleModules.has('closures') || visibleModules.has('externalInvolvement')`
 *  -- the one analytics fetch genuinely skipped (zero network call, zero
 *  server-side computation) when both of its personalizable modules are
 *  hidden. */
export function useIncidentClosureInsights(filters: AnalyticsFilters, options: { enabled?: boolean } = {}) {
  const session = useSession();
  const canonical = canonicalizeAnalyticsFilters(filters);
  return useQuery({
    queryKey: ['analyticsClosureInsights', canonical],
    queryFn: () => repo().getIncidentClosureInsights(session, canonical),
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
  });
}

/** The caller's own stored analytics module-visibility preference ("התאמת
 *  התצוגה"), or `null` when none is stored -- callers fall back to
 *  defaultAnalyticsModules(role) in that case (see
 *  src/domain/analyticsPreferences.ts). Not gated by role here: an
 *  ineligible role's read simply resolves to null (no stored row is ever
 *  visible to them), so the caller doesn't need to branch on role before
 *  calling this. */
export function useAnalyticsPreferences() {
  const session = useSession();
  return useQuery({
    queryKey: ['analyticsPreferences', session.userId],
    queryFn: () => repo().getAnalyticsPreferences(session),
  });
}

/** Sets (or, with `null`, resets to the role default) the caller's own
 *  analytics module visibility. Self-only and eligibility-gated server-side
 *  (migration 0052) -- an ineligible role's call is rejected with a
 *  controlled FORBIDDEN error via useAppMutation's normal error toast, not
 *  merely hidden in the UI. */
export function useSetAnalyticsPreferences() {
  const session = useSession();
  return useAppMutation((modules: AnalyticsModuleKey[] | null) => repo().setAnalyticsVisibleModules(session, modules), {
    invalidate: [['analyticsPreferences', session.userId]],
  });
}

/** Bounded, on-demand incident summaries for exactly ONE trend-chart bucket
 *  ("לחץ לצפייה בתקלות"). `bucketStart` is `null` while no bucket is
 *  selected -- `enabled: bucketStart !== null` means this never fires as
 *  part of the normal analytics page load, only once the user actually
 *  clicks a bar. `entityFilters` must be the SAME entity filters the trend
 *  chart's own data was computed from (no periodDays -- the bucket itself
 *  already pins the window), so the returned list can never disagree with
 *  the chart's own opened/closed counts for that bucket. */
export function useAnalyticsTrendBucketIncidents(
  bucketStart: string | null,
  bucketUnit: AnalyticsBucketUnit,
  entityFilters: AnalyticsEntityFilters,
) {
  const session = useSession();
  const canonical = canonicalizeAnalyticsFilters(entityFilters);
  return useQuery({
    queryKey: ['analyticsTrendBucketIncidents', bucketStart, bucketUnit, canonical],
    queryFn: () => repo().getAnalyticsTrendBucketIncidents(session, bucketStart!, bucketUnit, canonical),
    enabled: bucketStart !== null,
  });
}

export function useIncident(id: string | undefined) {
  const session = useSession();
  return useQuery({
    queryKey: ['incident', id],
    queryFn: () => repo().getIncident(session, id!),
    enabled: !!id,
    refetchInterval: 30_000, // detect concurrent changes / closures from other sessions
  });
}

export function useIncidentEvents(id: string | undefined) {
  const session = useSession();
  return useQuery({
    queryKey: ['incident-events', id],
    queryFn: () => repo().getIncidentEvents(session, id!),
    enabled: !!id,
  });
}

export function useIncidentUpdates(id: string | undefined) {
  const session = useSession();
  return useQuery({
    queryKey: ['incident-updates', id],
    queryFn: () => repo().getIncidentUpdates(session, id!),
    enabled: !!id,
  });
}

export function useIncidentCauseAssessments(id: string | undefined) {
  const session = useSession();
  return useQuery({
    queryKey: ['incident-cause-assessments', id],
    queryFn: () => repo().getIncidentCauseAssessments(session, id!),
    enabled: !!id,
  });
}

export function useIncidentTreatmentActions(id: string | undefined) {
  const session = useSession();
  return useQuery({
    queryKey: ['incident-treatment-actions', id],
    queryFn: () => repo().getIncidentTreatmentActions(session, id!),
    enabled: !!id,
  });
}

export function useIncidentClosures(id: string | undefined) {
  const session = useSession();
  return useQuery({
    queryKey: ['incident-closures', id],
    queryFn: () => repo().getIncidentClosures(session, id!),
    enabled: !!id,
  });
}

export function useIncidentRelations(id: string | undefined) {
  const session = useSession();
  return useQuery({
    queryKey: ['incident-relations', id],
    queryFn: () => repo().getIncidentRelations(session, id!),
    enabled: !!id,
  });
}

/**
 * Creation-time related-incident suggestions. `enabled` is the caller's
 * trigger-condition gate (systemId selected + description past the
 * meaningful-length floor) -- this hook never fires on its own just
 * because a query object was passed in. The query key is the full input
 * tuple, so any change to it (system/location/domain/description) is a
 * fresh cache entry -- stale results are never shown after an input
 * changes; TanStack Query simply supersedes them, no manual invalidation
 * needed. A failed lookup is silent by design (see IncidentCreatePage):
 * this hook exposes isError but nothing in this file decides what to do
 * with it.
 */
export function useSimilarIncidentSuggestions(
  query: { systemId: string; locationId: string | null; reportedDomain: IncidentDomain | null; description: string },
  enabled: boolean,
) {
  const session = useSession();
  return useQuery({
    queryKey: ['similar-incidents', query],
    queryFn: () => repo().suggestSimilarIncidents(session, query),
    enabled,
  });
}

export function useNotifications() {
  const session = useSession();
  return useQuery({
    queryKey: ['notifications', session.userId],
    queryFn: () => repo().listNotifications(session),
    refetchInterval: 30_000,
  });
}

export function useAuditLogs(filters: AuditFilters, page: number, pageSize: number, enabled: boolean) {
  const session = useSession();
  return useQuery({
    queryKey: ['audit', filters, page, pageSize],
    queryFn: () => repo().listAuditLogs(session, filters, page, pageSize),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useCanExport() {
  const session = useSession();
  return useQuery({ queryKey: ['can-export', session.userId], queryFn: () => repo().canExport(session) });
}

/**
 * Mutation wrapper: invalidates queries, surfaces Hebrew errors via toast,
 * and routes SESSION_EXPIRED to the session-expired flow.
 */
export function useAppMutation<TInput, TResult>(
  fn: (input: TInput) => Promise<TResult>,
  options: {
    invalidate?: string[][];
    successText?: string;
    onSuccess?: (result: TResult) => void;
    onError?: (error: AppError) => void;
  } = {},
) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { markSessionExpired } = useAuth();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      for (const key of options.invalidate ?? [
        ['incidents'],
        ['incident'],
        ['incident-events'],
        ['incident-updates'],
        ['incident-cause-assessments'],
        ['incident-treatment-actions'],
        ['incident-closures'],
        ['incident-relations'],
        ['notifications'],
        ['audit'],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      if (options.successText) toast(options.successText, 'success');
      options.onSuccess?.(result);
    },
    onError: (error: unknown) => {
      const appError =
        error instanceof AppError ? error : new AppError('NETWORK', 'אירעה שגיאה. הנתונים שהוזנו לא נשמרו — ניתן לנסות שוב.');
      if (appError.code === 'SESSION_EXPIRED') {
        markSessionExpired();
        return;
      }
      if (options.onError) options.onError(appError);
      else toast(appError.message, 'error');
    },
  });
}

export { repo };
