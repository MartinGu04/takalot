// "מערכות עם הכי הרבה תקלות שנפתחו בתקופה" -- top 5 systems for the
// selected period, ranked by incidents opened in it. Each row: a dominant
// system name on its own line, then the three sub-metrics as clearly
// separated mini-stat chips (not one run-on text line) -- reads like a
// compact table without using a real <table> element for list data,
// matching this codebase's convention elsewhere (RecentTerminalRow etc.).
import type { AnalyticsSystemRow } from '../../domain/analyticsSummary';
import { formatDurationMinutes } from '../../lib/time';
import { EmptyState } from '../ui';

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0 rounded-lg bg-surface-active/60 px-1.5 py-2 text-center">
      <div className="truncate text-[11px] font-medium text-muted">{label}</div>
      {/* No truncate on the value: this chip is the narrowest place a
          duration string appears on the page (roughly a third of the KPI
          cards' own width), so clipping it with an ellipsis would silently
          hide real data (e.g. "11 שעות, 10…" losing the minutes) rather
          than just wrapping to a second line, which is the acceptable
          trade-off here. */}
      <div
        className={
          typeof value === 'number'
            ? 'mt-0.5 text-sm font-bold text-text-primary'
            : 'mt-0.5 text-xs font-bold leading-snug text-text-primary'
        }
      >
        {value}
      </div>
    </div>
  );
}

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
    <div className="flex flex-col gap-2.5">
      {rows.map((row, index) => (
        <div key={row.systemId} className="surface flex flex-col gap-3 p-3.5 sm:p-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-active text-xs font-bold text-text-secondary">
              {index + 1}
            </span>
            <span className="truncate text-base font-bold text-text-primary">{row.systemName}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <MiniStat label="נפתחו" value={row.openedInPeriod} />
            <MiniStat label="פתוחות" value={row.currentlyOpen} />
            <MiniStat label="זמן סגירה" value={formatDurationMinutes(row.avgCloseMinutes)} />
          </div>
        </div>
      ))}
    </div>
  );
}
