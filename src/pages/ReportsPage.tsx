// ניתוחים -- operational incident analytics. v1.4.0: six KPI cards (median
// resolution time as the primary duration metric, average kept as tooltip
// context), an opened-vs-closed trend chart, and top-systems/top-locations
// rankings (now ranked by median close time) -- all driven by
// getIncidentAnalytics (Supabase: get_incident_analytics_v2, migration
// 0051) -- kept in sync with the page's period/system/location/severity/
// domain/confirmed-cause/treatment-outcome filters via the URL (shareable/
// bookmarkable, same convention as ArchivePage/IncidentsPage).
import { useEffect, useRef, useState } from 'react';
import {
  useAnalyticsPreferences,
  useIncidentAnalytics,
  useIncidentClosureInsights,
  useIncidentOpenBacklog,
  useLocations,
  useSetAnalyticsPreferences,
  useSystems,
} from '../data/hooks';
import { useSession } from '../auth/AuthContext';
import { useUrlState } from '../lib/useUrlState';
import { formatDurationMinutes } from '../lib/time';
import { bucketUnitForPeriod, type AnalyticsBucket, type AnalyticsFilters, type AnalyticsPeriodDays } from '../domain/analyticsSummary';
import { SEVERITY_ORDER, type ConfirmedCause, type IncidentDomain, type Severity, type TreatmentOutcome } from '../domain/types';
import { CONFIRMED_CAUSE_ORDER, INCIDENT_DOMAIN_ORDER, TREATMENT_OUTCOME_ORDER } from '../domain/labels';
import { canPersonalizeAnalytics, defaultAnalyticsModules } from '../domain/analyticsPreferences';
import { AnalyticsFilterBar } from '../components/analytics/AnalyticsFilterBar';
import { AnalyticsKpiCard } from '../components/analytics/AnalyticsKpiCard';
import { AnalyticsInfoTooltip } from '../components/analytics/AnalyticsInfoTooltip';
import { AnalyticsViewSettingsDialog } from '../components/analytics/AnalyticsViewSettingsDialog';
import { IncidentTrendChart } from '../components/analytics/IncidentTrendChart';
import { TrendBucketDrilldown } from '../components/analytics/TrendBucketDrilldown';
import { AgeDistributionChart } from '../components/analytics/AgeDistributionChart';
import { TopSystemsList } from '../components/analytics/TopSystemsList';
import { TopLocationsList } from '../components/analytics/TopLocationsList';
import { ClosureBreakdownPanel } from '../components/analytics/ClosureBreakdownPanel';
import { Button, ErrorState, Spinner } from '../components/ui';
import {
  IconAlertTriangle,
  IconArrowsExchange,
  IconCheck,
  IconClock,
  IconPlus,
  IconPulse,
  IconSettings,
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

function isValidDomain(value: string): value is IncidentDomain {
  return (INCIDENT_DOMAIN_ORDER as string[]).includes(value);
}

function isValidConfirmedCause(value: string): value is ConfirmedCause {
  return (CONFIRMED_CAUSE_ORDER as string[]).includes(value);
}

function isValidTreatmentOutcome(value: string): value is TreatmentOutcome {
  return (TREATMENT_OUTCOME_ORDER as string[]).includes(value);
}

/**
 * Parses filters from the URL, validating every field before it can ever
 * reach the repository/RPC -- an unrecognized period already fell back to
 * 30 silently; every other field gets the same treatment instead of being
 * cast through unchecked, which would otherwise let a stale or hand-edited
 * URL (e.g. ?severity=bogus) reach PostgREST and surface as an uncontrolled
 * Postgres enum/uuid cast error rather than a graceful fallback.
 *
 * `urlFixups` describes exactly what the address bar needs corrected: for a
 * scalar field (period/system/location) an invalid value maps to
 * `undefined` (delete the whole param). For a multi-value field (severity/
 * domain/confirmedCause/treatmentOutcome) validation is PER-ENTRY -- one
 * bad entry inside an otherwise-valid comma-joined list is dropped
 * individually and `urlFixups` maps that key to just the surviving valid
 * entries, never to `undefined` for the whole list (that would also throw
 * away the entries that were fine).
 */
function filtersFromUrl(url: ReturnType<typeof useUrlState>): {
  filters: AnalyticsFilters;
  urlFixups: Record<string, string | string[] | undefined>;
} {
  const urlFixups: Record<string, string | string[] | undefined> = {};

  const periodRaw = url.get('period');
  const periodNum = Number(periodRaw);
  let periodDays: AnalyticsPeriodDays = 30;
  if (periodRaw !== undefined) {
    if ((VALID_PERIODS as number[]).includes(periodNum)) periodDays = periodNum as AnalyticsPeriodDays;
    else urlFixups.period = undefined;
  }

  const systemRaw = url.get('system');
  let systemId: string | undefined;
  if (systemRaw !== undefined) {
    if (isValidUuid(systemRaw)) systemId = systemRaw;
    else urlFixups.system = undefined;
  }

  const locationRaw = url.get('location');
  let locationId: string | undefined;
  if (locationRaw !== undefined) {
    if (isValidUuid(locationRaw)) locationId = locationRaw;
    else urlFixups.location = undefined;
  }

  const unclassifiedRaw = url.get('unclassified');
  let includeUnclassifiedDomain: boolean | undefined;
  if (unclassifiedRaw !== undefined) {
    if (unclassifiedRaw === '1') includeUnclassifiedDomain = true;
    else urlFixups.unclassified = undefined;
  }

  function parseList<T extends string>(key: string, isValid: (v: string) => v is T): T[] | undefined {
    const raw = url.getList(key);
    if (raw.length === 0) return undefined;
    const valid = raw.filter(isValid);
    if (valid.length !== raw.length) urlFixups[key] = valid.length > 0 ? valid : undefined;
    return valid.length > 0 ? valid : undefined;
  }

  const severities = parseList('severity', isValidSeverity);
  const domains = parseList('domain', isValidDomain);
  const confirmedCauses = parseList('confirmedCause', isValidConfirmedCause);
  const treatmentOutcomes = parseList('treatmentOutcome', isValidTreatmentOutcome);

  return {
    filters: { periodDays, systemId, locationId, severities, domains, includeUnclassifiedDomain, confirmedCauses, treatmentOutcomes },
    urlFixups,
  };
}

export default function ReportsPage() {
  const url = useUrlState();
  const session = useSession();
  const { filters, urlFixups } = filtersFromUrl(url);
  const { data: systems } = useSystems();
  const { data: locations } = useLocations();
  const { data, isLoading, isError, refetch } = useIncidentAnalytics(filters);

  // Personalization ("התאמת התצוגה"): the six toggleable modules below (KPI
  // row and filter bar are never personalizable). `storedModules` is
  // `undefined` while loading, `null` once loaded with nothing stored (an
  // ineligible role always resolves here -- RLS never returns them a row),
  // and an array once the caller has customized their view. Falls back to
  // this role's starting set (defaultAnalyticsModules) in the first two
  // cases, so every render past the initial load has a concrete, non-empty
  // set to gate against -- no "is it still loading" branch needed by any
  // section below.
  const { data: storedModules } = useAnalyticsPreferences();
  const visibleModules = new Set(storedModules ?? defaultAnalyticsModules(session.role));
  const setModules = useSetAnalyticsPreferences();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Entity-only filters, deliberately excluding periodDays -- age/backlog is
  // not period-bound, and keeping periodDays out of this object (rather
  // than just ignoring it downstream) is what keeps useIncidentOpenBacklog's
  // query key stable across a period change, so it never refetches for one.
  const { periodDays: _periodDays, ...entityFilters } = filters;
  // The two genuinely skippable fetches (see the RPC-architecture note in
  // supabase/migrations/0051_incident_analytics_v2_rpcs.sql): hiding
  // closures means useIncidentClosureInsights never fires at all, and
  // hiding ageDistribution means useIncidentOpenBacklog never fires.
  // trend/topSystems/topLocations have no hook of their own to gate --
  // their data already arrives inside useIncidentAnalytics's always-fetched
  // response, so hiding those three only gates rendering below, never a
  // request.
  const { data: backlog } = useIncidentOpenBacklog(entityFilters, { enabled: visibleModules.has('ageDistribution') });
  const { data: closureInsights } = useIncidentClosureInsights(filters, {
    enabled: visibleModules.has('closures'),
  });

  // Trend chart drill-down ("לחץ לצפייה בתקלות"): the selected bucket is a
  // snapshot of the exact AnalyticsBucket the chart rendered (bucketStart/
  // opened/closed), never re-derived -- see TrendBucketDrilldown's header
  // for why. bucketUnit is the same day/week rule the trend's own buckets
  // were built from (bucketUnitForPeriod), so a click can only ever resolve
  // to a bucket boundary the chart itself already drew.
  const trendAnchorRef = useRef<HTMLDivElement>(null);
  const [selectedBucket, setSelectedBucket] = useState<AnalyticsBucket | null>(null);
  const bucketUnit = bucketUnitForPeriod(filters.periodDays);
  // Closes the drill-down the moment any filter/period changes -- otherwise
  // the already-open panel would keep showing a bucket's opened/closed
  // counts from BEFORE the change, no longer matching what the (now
  // refetched) chart displays for that same bucket key.
  const filtersKey = JSON.stringify(filters);
  useEffect(() => {
    setSelectedBucket(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  // Correct any invalid filter params in the address bar (replace
  // semantics, via useUrlState -- no new history entry, so back/forward
  // navigation and a retry of the same link can't reproduce the malformed
  // state or loop). Runs once per distinct set of fixups: after they're
  // applied, filtersFromUrl recomputes urlFixups as {}, the effect's
  // dependency collapses to the same empty key, and it goes quiet.
  const urlFixupsKey = JSON.stringify(urlFixups);
  useEffect(() => {
    if (Object.keys(urlFixups).length === 0) return;
    url.setMany(urlFixups);
    // Depend on the stable, primitive form (urlFixupsKey), not the
    // urlFixups object itself -- filtersFromUrl returns a fresh object every
    // render, which would otherwise re-run this effect on every render
    // regardless of whether its content actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlFixupsKey, url.setMany]);

  const handleFilterChange = (next: AnalyticsFilters) => {
    url.setMany({
      period: String(next.periodDays),
      system: next.systemId,
      location: next.locationId,
      severity: next.severities,
      domain: next.domains,
      unclassified: next.includeUnclassifiedDomain ? '1' : undefined,
      confirmedCause: next.confirmedCauses,
      treatmentOutcome: next.treatmentOutcomes,
    });
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">ניתוח תקלות</h1>
          <p className="mt-1.5 text-secondary">מגמות, ביצועים ונקודות שדורשות תשומת לב</p>
        </div>
        {/* Personalization affordance -- shift_supervisor+ only (see
            canPersonalizeAnalytics); viewer/technician always see the full
            fixed module set below, with no toggle rendered for them at all. */}
        {canPersonalizeAnalytics(session.role) && (
          <Button variant="secondary" onClick={() => setSettingsOpen(true)}>
            <IconSettings className="size-4" />
            התאמת התצוגה
          </Button>
        )}
      </div>

      {canPersonalizeAnalytics(session.role) && (
        <AnalyticsViewSettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          role={session.role}
          visibleModules={[...visibleModules]}
          saving={setModules.isPending}
          onSave={(modules) =>
            setModules.mutate(modules, {
              onSuccess: () => setSettingsOpen(false),
            })
          }
        />
      )}

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
              label="זמן טיפול חציוני"
              value={formatDurationMinutes(data.medianCloseMinutes)}
              context="מגילוי ועד סגירה בפועל"
              tone="blue"
              infoTooltip={`מחצית מהתקלות נסגרו בזמן קצר יותר ומחצית בזמן ארוך יותר. המדד פחות מושפע מתקלות חריגות שנמשכו זמן רב מאוד. זמן הסגירה הממוצע בתקופה זו: ${formatDurationMinutes(data.avgCloseMinutes)}.`}
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
              infoTooltip="מספר התקלות שנפתחו מחדש בתקופה שנבחרה, לאחר שנסגרו. תקלה שנפתחה מחדש יותר מפעם אחת בתקופה נספרת פעם אחת בלבד."
            />
          </div>

          {visibleModules.has('trend') && (
            <section className="mt-8" aria-labelledby="analytics-trend-heading">
              <h2 id="analytics-trend-heading" className="section-title">פתיחת וסגירת תקלות</h2>
              <div ref={trendAnchorRef} className="surface mt-3 p-4 sm:p-5">
                <IncidentTrendChart buckets={data.buckets} onBucketClick={setSelectedBucket} />
              </div>
              <TrendBucketDrilldown
                bucket={selectedBucket}
                bucketUnit={bucketUnit}
                entityFilters={entityFilters}
                systems={systems}
                anchorRef={trendAnchorRef}
                onClose={() => setSelectedBucket(null)}
              />
            </section>
          )}

          {visibleModules.has('ageDistribution') && (
            <section className="mt-8" aria-labelledby="analytics-backlog-heading">
              <div className="flex items-center gap-1.5">
                <h2 id="analytics-backlog-heading" className="section-title">גיל תקלות פתוחות</h2>
                <AnalyticsInfoTooltip text="מודול זה מציג את התקלות הפתוחות כרגע ואינו מושפע מהתקופה שנבחרה בסינון." />
              </div>
              <div className="surface mt-3 p-4 sm:p-5">
                {backlog ? <AgeDistributionChart backlog={backlog} /> : <Spinner label="טוען נתוני גיל תקלות…" />}
              </div>
            </section>
          )}

          {/* Side by side once the width comfortably fits two compact
              ranking panels plus their column headers (lg:); stacked below
              that, same as every other responsive section on this page.
              Only rendered at all once at least one of the two rankings is
              visible -- a lone visible one still gets the grid's first
              track (full-width on narrower screens, half-width at lg:,
              with the second track simply empty), no separate single-
              column variant needed. */}
          {(visibleModules.has('topSystems') || visibleModules.has('topLocations')) && (
            <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
              {visibleModules.has('topSystems') && (
                <section>
                  <h2 className="section-title">מערכות עם הכי הרבה תקלות</h2>
                  <p className="mt-0.5 text-xs text-muted">דירוג לפי מספר התקלות שנפתחו בתקופה שנבחרה</p>
                  <div className="mt-3">
                    <TopSystemsList rows={data.topSystems} />
                  </div>
                </section>
              )}
              {visibleModules.has('topLocations') && (
                <section>
                  <h2 className="section-title">מיקומים עם הכי הרבה תקלות</h2>
                  <p className="mt-0.5 text-xs text-muted">דירוג לפי מספר התקלות שנפתחו בתקופה שנבחרה</p>
                  <div className="mt-3">
                    <TopLocationsList rows={data.topLocations} />
                  </div>
                </section>
              )}
            </div>
          )}

          {visibleModules.has('closures') && (
            <section className="mt-8">
              <h2 className="section-title">סיווג סגירות</h2>
              <p className="mt-0.5 text-xs text-muted">גורם שאומת ותוצאת הטיפול, לפי סגירות מובנות בתקופה שנבחרה</p>
              <div className="surface mt-3 p-4 sm:p-5">
                {closureInsights ? (
                  <ClosureBreakdownPanel
                    insights={closureInsights}
                    causeOrOutcomeFilterActive={
                      (filters.confirmedCauses?.length ?? 0) > 0 || (filters.treatmentOutcomes?.length ?? 0) > 0
                    }
                  />
                ) : (
                  <Spinner label="טוען נתוני סיווג סגירות…" />
                )}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
