// A single KPI tile for the ניתוחים (analytics) page. Deliberately
// non-interactive (a <div>, not a <button>) for this first slice -- unlike
// DashboardPage's KpiCard, these six metrics aren't all backed by a single
// "the list behind this number" (two of six are averages), so drill-down
// is left for a later slice rather than half-applied here.
import type { SVGProps } from 'react';

export function AnalyticsKpiCard({
  icon: Icon,
  label,
  value,
  context,
}: {
  icon: (props: SVGProps<SVGSVGElement>) => React.JSX.Element;
  label: string;
  value: string | number;
  context: string;
}) {
  return (
    <div className="surface flex min-w-0 flex-col gap-3 border-brand-200 p-4 text-right dark:border-brand-800 sm:p-5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-400">
          <Icon className="size-5.5" />
        </span>
        <div className="text-2xl font-extrabold leading-none text-text-primary sm:text-3xl">{value}</div>
      </div>
      <div className="min-w-0">
        {/* No truncate: Hebrew KPI labels/context must wrap on narrow
            screens rather than lose text to an ellipsis. */}
        <div className="text-sm font-bold leading-snug text-text-primary">{label}</div>
        <div className="mt-0.5 text-xs leading-snug text-muted">{context}</div>
      </div>
    </div>
  );
}
