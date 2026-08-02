// ניתוחים -- operational incident analytics. First vertical slice: six KPI
// cards, an opened-vs-closed trend chart, and a top-systems ranking, all
// driven by a single get_incident_analytics RPC call (migration 0036) kept
// in sync with the page's period/system/location/severity filters via the
// URL (shareable/bookmarkable, same convention as ArchivePage/IncidentsPage).
import { useIncidentAnalytics, useLocations, useSystems } from '../data/hooks';
import { useUrlState } from '../lib/useUrlState';
import { formatDurationMinutes } from '../lib/time';
import type { AnalyticsFilters, AnalyticsPeriodDays } from '../domain/analyticsSummary';
import type { Severity } from '../domain/types';
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

function filtersFromUrl(url: ReturnType<typeof useUrlState>): AnalyticsFilters {
  const periodRaw = Number(url.get('period'));
  const periodDays = (VALID_PERIODS as number[]).includes(periodRaw) ? (periodRaw as AnalyticsPeriodDays) : 30;
  return {
    periodDays,
    systemId: url.get('system'),
    locationId: url.get('location'),
    severity: url.get('severity') as Severity | undefined,
  };
}

export default function ReportsPage() {
  const url = useUrlState();
  const filters = filtersFromUrl(url);
  const { data: systems } = useSystems();
  const { data: locations } = useLocations();
  const { data, isLoading, isError, refetch } = useIncidentAnalytics(filters);

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
      <p className="mt-1 text-secondary">מגמות, ביצועים ונקודות שדורשות תשומת לב</p>

      <div className="mt-4">
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
          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
            <AnalyticsKpiCard
              icon={IconPlus}
              label="נפתחו בתקופה"
              value={data.openedInPeriod}
              context="תקלות שהתגלו בתקופה שנבחרה"
            />
            <AnalyticsKpiCard
              icon={IconCheck}
              label="נסגרו בתקופה"
              value={data.closedInPeriod}
              context="תקלות שנסגרו בתקופה שנבחרה"
            />
            <AnalyticsKpiCard
              icon={IconClock}
              label="זמן ממוצע לסגירה"
              value={formatDurationMinutes(data.avgCloseMinutes)}
              context="מרגע הגילוי ועד לסגירה בפועל"
            />
            <AnalyticsKpiCard
              icon={IconPulse}
              label="פתוחות עכשיו"
              value={data.currentlyOpen}
              context="כל התקלות הפעילות כרגע"
            />
            <AnalyticsKpiCard
              icon={IconAlertTriangle}
              label="כמה זמן הן פתוחות"
              value={formatDurationMinutes(data.avgOpenMinutes)}
              context="ממוצע זמן פתיחה של התקלות הפעילות"
            />
            <AnalyticsKpiCard
              icon={IconArrowsExchange}
              label="נפתחו מחדש"
              value={data.reopenedInPeriod}
              context="תקלות שנפתחו מחדש בתקופה שנבחרה"
            />
          </div>

          <section className="mt-6">
            <h2 className="section-title">פתיחת וסגירת תקלות</h2>
            <div className="surface mt-2 p-3 sm:p-4">
              <IncidentTrendChart buckets={data.buckets} />
            </div>
          </section>

          <section className="mt-6">
            <h2 className="section-title">מערכות עם הכי הרבה תקלות</h2>
            <div className="mt-2">
              <TopSystemsList rows={data.topSystems} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
