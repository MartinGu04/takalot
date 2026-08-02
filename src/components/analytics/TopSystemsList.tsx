// "מערכות עם הכי הרבה תקלות" -- top 5 systems for the selected period.
// Stacked responsive rows, matching DashboardPage's RecentTerminalRow
// idiom rather than an HTML table (no part of this codebase uses a real
// table for list data).
import type { AnalyticsSystemRow } from '../../domain/analyticsSummary';
import { formatDurationMinutes } from '../../lib/time';
import { EmptyState } from '../ui';

export function TopSystemsList({ rows }: { rows: AnalyticsSystemRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="אין תקלות בתקופה שנבחרה"
        subtitle="נסו להרחיב את התקופה או לשנות את הסינון."
      />
    );
  }
  return (
    <div className="surface flex flex-col divide-y divide-hairline p-1">
      {rows.map((row, index) => (
        <div
          key={row.systemId}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2.5 py-2.5"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-active text-xs font-bold text-text-secondary">
              {index + 1}
            </span>
            <span className="truncate font-bold text-text-primary">{row.systemName}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-secondary">
            <span>{row.openedInPeriod} נפתחו בתקופה</span>
            <span>{row.currentlyOpen} פתוחות עכשיו</span>
            <span>ממוצע סגירה: {formatDurationMinutes(row.avgCloseMinutes)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
