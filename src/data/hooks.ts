// TanStack Query hooks over the repository abstraction.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRepository } from './index';
import { AppError, type AnalyticsFilters, type AuditFilters, type IncidentFilters, type IncidentSort } from './repository';
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
  return useQuery({
    queryKey: ['analytics', filters],
    queryFn: () => repo().getIncidentAnalytics(session, filters),
    placeholderData: keepPreviousData,
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
      for (const key of options.invalidate ?? [['incidents'], ['incident'], ['incident-events'], ['incident-updates'], ['notifications'], ['audit']]) {
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
