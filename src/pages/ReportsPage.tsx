// ניתוחים -- operational incident analytics. First vertical slice: six KPI
// cards, an opened-vs-closed trend chart, and a top-systems ranking, all
// driven by a single get_incident_analytics RPC call (migration 0036) kept
// in sync with the page's period/system/location/severity filters via the
// URL (shareable/bookmarkable, same convention as ArchivePage/IncidentsPage).
import { useEffect } from 'react';
import { useIncidentAnalytics, useLocations, useSystems } from '../data/hooks';
import { useUrlState } from '../lib/useUrlState';
import { formatDurationMinutes } from '../lib/time';
import type { AnalyticsFilters, AnalyticsPeriodDays } from '../domain/analyticsSummary';
import { SEVERITY_ORDER, type Severity } from '../domain/types';
import { AnalyticsFilterBar } from '../components/analytics/AnalyticsFilterBar';
import { AnalyticsKpiCard } from '../components/analytics/AnalyticsKpiCard';
import { IncidentTrendChart } from '../components/analytics/IncidentTrendChart';
import { TopSystemsList } from '../components/analytics/TopSystemsList';
import { ErrorState, Spinner } from '../components/ui';
import {
  IconAlertTriangle,
  IconArrowsExchange,
  IconCheck,
  IconClock,
  IconPlus,
  IconPulse,
} from '../components/icons';

const VALID_PERIODS: AnalyticsPeriodDays[] = [7, 30, 90];
// RFC 4122 syntax check only -- deliberately not cross-referenced against
// the loaded systems/locations lists, which may still be undefined on the
// very first render (that would race against a perfectly valid id and
// strip it before the reference data has even loaded).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function isValidSeverity(value: string): value is Severity {
  return (SEVERITY_ORDER as string[]).includes(value);
}

/**
 * Parses filters from the URL, validating every field before it can ever
 * reach the repository/RPC -- an unrecognized period already fell back to
 * 30 silently; system/location/severity now get the same treatment
 * instead of being cast through unchecked, which previously let a stale
 * or hand-edited URL (e.g. ?severity=bogus) reach PostgREST and surface as
 * an uncontrolled Postgres enum/uuid cast error rather than a graceful
 * fallback. `invalidParamKeys` lists exactly the raw URL keys that were
 * rejected, so the caller can strip them from the address bar (replace
 * semantics -- see the effect in ReportsPage) rather than leaving a
 * malformed URL a retry or back-navigation could reuse.
 */
function filtersFromUrl(url: ReturnType<typeof useUrlState>): {
  filters: AnalyticsFilters;
  invalidParamKeys: string[];
} {
  const invalidParamKeys: string[] = [];

  const periodRaw = url.get('period');
  const periodNum = Number(periodRaw);
  let periodDays: AnalyticsPeriodDays = 30;
  if (periodRaw !== undefined) {
    if ((VALID_PERIODS as number[]).includes(periodNum)) periodDays = periodNum as AnalyticsPeriodDays;
    else invalidParamKeys.push('period');
  }

  const systemRaw = url.get('system');
  let systemId: string | undefined;
  if (systemRaw !== undefined) {
    if (isValidUuid(systemRaw)) systemId = systemRaw;
    else invalidParamKeys.push('system');
  }

  const locationRaw = url.get('location');
  let locationId: string | undefined;
  if (locationRaw !== undefined) {
    if (isValidUuid(locationRaw)) locationId = locationRaw;
    else invalidParamKeys.push('location');
  }

  const severityRaw = url.get('severity');
  let severity: Severity | undefined;
  if (severityRaw !== undefined) {
    if (isValidSeverity(severityRaw)) severity = severityRaw;
    else invalidParamKeys.push('severity');
  }

  return { filters: { periodDays, systemId, locationId, severity }, invalidParamKeys };
}

export default function ReportsPage() {
  const url = useUrlState();
  const { filters, invalidParamKeys } = filtersFromUrl(url);
  const { data: systems } = useSystems();
  const { data: locations } = useLocations();
  const { data, isLoading, isError, refetch } = useIncidentAnalytics(filters);

  // Strip any invalid filter params from the address bar (replace
  // semantics, via useUrlState -- no new history entry, so back/forward
  // navigation and a retry of the same link can't reproduce the malformed
  // state or loop). Runs once per distinct set of invalid keys: after the
  // strip, filtersFromUrl recomputes invalidParamKeys as [], the effect's
  // dependency collapses to the same empty string, and it goes quiet.
  const invalidParamKeysKey = invalidParamKeys.join(',');
  useEffect(() => {
    if (invalidParamKeys.length === 0) return;
    const updates: Record<string, undefined> = {};
    for (const key of invalidParamKeys) updates[key] = undefined;
    url.setMany(updates);
    // Depend on the stable, primitive form (invalidParamKeysKey), not the
    // invalidParamKeys array itself -- filtersFromUrl returns a fresh array
    // every render, which would otherwise re-run this effect on every
    // render regardless of whether its content actually changed.
  }, [invalidParamKeysKey, url.setMany]);

  const handleFilterChange = (next: AnalyticsFilters) => {
    url.setMany({
      period: String(next.periodDays),
      system: next.systemId,
      location: next.locationId,
      severity: next.severity,
    });
  };

  return (
    <div>
      <h1 className="page-title">ניתוח תקלות</h1>
      <p className="mt-1.5 text-secondary">מגמות, ביצועים ונקודות שדורשות תשומת לב</p>

      <div className="mt-5">
        <AnalyticsFilterBar
          value={filters}
          onChange={handleFilterChange}
          onReset={() => url.clear()}
          systems={systems}
          locations={locations}
        />
      </div>

      {isLoading && <Spinner label="טוען נתוני ניתוח…" className="mt-8" />}

      {isError && (
        <div className="mt-6">
          <ErrorState message="שגיאה בטעינת נתוני הניתוח. בדקו את החיבור ונסו שוב." onRetry={() => refetch()} />
        </div>
      )}

      {data && (
        <>
          {/* Capped at 3 columns (never the full 6-across): the page's own
              max-w-6xl container leaves each card too narrow past 3-up for
              a comfortable icon + large number + wrapping Hebrew label to
              sit in, especially the two duration-string cards. 3x2 gives
              every card consistent, comfortable proportions at any desktop
              width instead of shrinking further on ultra-wide screens. */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
            <AnalyticsKpiCard
              icon={IconPlus}
              label="נפתחו בתקופה"
              value={data.openedInPeriod}
              context="תקלות שהתגלו בתקופה שנבחרה"
              tone="brand"
            />
            <AnalyticsKpiCard
              icon={IconCheck}
              label="נסגרו בתקופה"
              value={data.closedInPeriod}
              context="תקלות שנסגרו בתקופה שנבחרה"
              tone="green"
            />
            <AnalyticsKpiCard
              icon={IconClock}
              label="זמן סגירה ממוצע"
              value={formatDurationMinutes(data.avgCloseMinutes)}
              context="מגילוי ועד סגירה בפועל"
              tone="blue"
            />
            <AnalyticsKpiCard
              icon={IconPulse}
              label="פתוחות עכשיו"
              value={data.currentlyOpen}
              context="כל התקלות הפעילות כרגע"
              tone="orange"
            />
            <AnalyticsKpiCard
              icon={IconAlertTriangle}
              label="משך פתיחה ממוצע"
              value={formatDurationMinutes(data.avgOpenMinutes)}
              context="מגילוי ועד עכשיו"
              tone="amber"
            />
            <AnalyticsKpiCard
              icon={IconArrowsExchange}
              label="נפתחו מחדש"
              value={data.reopenedInPeriod}
              context="בתקופה שנבחרה"
              tone="red"
            />
          </div>

          <section className="mt-8" aria-labelledby="analytics-trend-heading">
            <h2 id="analytics-trend-heading" className="section-title">פתיחת וסגירת תקלות</h2>
            <div className="surface mt-3 p-4 sm:p-5">
              <IncidentTrendChart buckets={data.buckets} />
            </div>
          </section>

          <section className="mt-8">
            <h2 className="section-title">מערכות עם הכי הרבה תקלות</h2>
            <p className="mt-0.5 text-xs text-muted">דירוג לפי תקלות שנפתחו בתקופה שנבחרה</p>
            <div className="mt-3">
              <TopSystemsList rows={data.topSystems} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
