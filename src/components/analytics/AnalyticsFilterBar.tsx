// Filter bar for the ניתוחים (analytics) page: period + system/location/
// severity + reset. Deliberately single-select for system/location/
// severity (unlike IncidentFilterBar's multi-select severity chips) --
// simplest to reason about for six aggregate KPIs computed server-side.
import type { AnalyticsFilters, AnalyticsPeriodDays } from '../../domain/analyticsSummary';
import type { LocationRecord, Severity, SystemRecord } from '../../domain/types';
import { severityLabels } from '../../domain/labels';
import { SystemOptions, LocationOptions } from '../ReferenceDataOptions';
import { Button, Select } from '../ui';

const PERIODS: AnalyticsPeriodDays[] = [7, 30, 90];
const ALL_SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

export const DEFAULT_ANALYTICS_FILTERS: AnalyticsFilters = { periodDays: 30 };

export function isDefaultAnalyticsFilters(value: AnalyticsFilters): boolean {
  return (
    value.periodDays === DEFAULT_ANALYTICS_FILTERS.periodDays &&
    !value.systemId &&
    !value.locationId &&
    !value.severity
  );
}

export function AnalyticsFilterBar({
  value,
  onChange,
  onReset,
  systems,
  locations,
}: {
  value: AnalyticsFilters;
  onChange: (next: AnalyticsFilters) => void;
  onReset: () => void;
  systems?: SystemRecord[];
  locations?: LocationRecord[];
}) {
  return (
    <div className="surface flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="תקופה">
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onChange({ ...value, periodDays: p })}
            aria-pressed={value.periodDays === p}
            className={
              value.periodDays === p
                ? 'min-h-9 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white dark:bg-brand-500'
                : 'min-h-9 rounded-lg bg-surface-active px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-surface-hover'
            }
          >
            {p} ימים
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Select
          aria-label="סינון לפי מערכת"
          className="min-w-0"
          value={value.systemId ?? ''}
          onChange={(e) => onChange({ ...value, systemId: e.target.value || undefined })}
        >
          <option value="">כל המערכות</option>
          <SystemOptions systems={systems} includeArchived />
        </Select>
        <Select
          aria-label="סינון לפי מיקום"
          className="min-w-0"
          value={value.locationId ?? ''}
          onChange={(e) => onChange({ ...value, locationId: e.target.value || undefined })}
        >
          <option value="">כל המיקומים</option>
          <LocationOptions locations={locations} includeArchived />
        </Select>
        <Select
          aria-label="סינון לפי חומרה"
          className="min-w-0"
          value={value.severity ?? ''}
          onChange={(e) => onChange({ ...value, severity: (e.target.value || undefined) as Severity | undefined })}
        >
          <option value="">כל החומרות</option>
          {ALL_SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {severityLabels[s]}
            </option>
          ))}
        </Select>
        <Button
          variant="ghost"
          onClick={onReset}
          disabled={isDefaultAnalyticsFilters(value)}
          className="min-w-0"
        >
          איפוס סינונים
        </Button>
      </div>
    </div>
  );
}
