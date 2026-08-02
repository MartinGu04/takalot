// A single KPI tile for the ניתוחים (analytics) page. Deliberately
// non-interactive (a <div>, not a <button>) for this first slice -- unlike
// DashboardPage's KpiCard, these six metrics aren't all backed by a single
// "the list behind this number" (two of six are averages), so drill-down
// is left for a later slice rather than half-applied here.
//
// Accessibility: the DOM renders value-before-label (icon+value on top,
// label+context below) to match the established KpiCard visual layout,
// which reads backwards to assistive tech if left as plain text nodes.
// Mirrors DashboardPage's KpiCard fix for the same problem: role="group"
// with a single aria-label built in the natural label -> value -> context
// order, and the visible content marked aria-hidden so that label is the
// ONLY thing announced -- not the label followed by a second, redundant
// read of the same value/label/context text nodes in DOM order.
//
// Color: each KPI gets a fixed, restrained semantic tone (icon background +
// icon color + a thin permanent border) so the six cards read as distinct
// operational categories rather than one undifferentiated purple block.
// The tone is a category marker, not an urgency signal -- it never changes
// based on the card's own value (no SLA or comparison baseline exists to
// judge "good" or "bad" against), unlike DashboardPage's KpiCard, whose
// color intentionally dims at zero. The big number itself stays neutral
// (text-text-primary) on every card, deliberately not tinted, so six tones
// at once still reads as calm and restrained rather than a noisy dashboard.
import type { SVGProps } from 'react';

export type KpiTone = 'brand' | 'green' | 'blue' | 'orange' | 'amber' | 'red';

const toneStyles: Record<KpiTone, { iconBg: string; iconColor: string; border: string }> = {
  brand: {
    iconBg: 'bg-brand-50 dark:bg-brand-950/60',
    iconColor: 'text-brand-600 dark:text-brand-400',
    border: 'border-brand-200 dark:border-brand-800',
  },
  green: {
    iconBg: 'bg-emerald-50 dark:bg-emerald-950/60',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
    border: 'border-emerald-200 dark:border-emerald-800',
  },
  blue: {
    iconBg: 'bg-blue-50 dark:bg-blue-950/60',
    iconColor: 'text-blue-600 dark:text-blue-400',
    border: 'border-blue-200 dark:border-blue-800',
  },
  orange: {
    iconBg: 'bg-orange-50 dark:bg-orange-950/60',
    iconColor: 'text-orange-600 dark:text-orange-400',
    border: 'border-orange-200 dark:border-orange-800',
  },
  amber: {
    iconBg: 'bg-amber-50 dark:bg-amber-950/60',
    iconColor: 'text-amber-600 dark:text-amber-400',
    border: 'border-amber-200 dark:border-amber-800',
  },
  red: {
    iconBg: 'bg-red-50 dark:bg-red-950/60',
    iconColor: 'text-red-600 dark:text-red-400',
    border: 'border-red-200 dark:border-red-800',
  },
};

export function AnalyticsKpiCard({
  icon: Icon,
  label,
  value,
  context,
  tone = 'brand',
}: {
  icon: (props: SVGProps<SVGSVGElement>) => React.JSX.Element;
  label: string;
  value: string | number;
  context: string;
  tone?: KpiTone;
}) {
  const t = toneStyles[tone];
  return (
    <div
      role="group"
      aria-label={`${label}: ${value}. ${context}.`}
      className={`surface flex min-w-0 flex-col gap-4 p-5 text-right sm:p-6 ${t.border}`}
    >
      {/* Numeric counts keep the icon beside the value (it's always short
          enough to share the row). String (duration) values stack the icon
          ABOVE the value instead, below the sm: breakpoint only -- at a
          2-column mobile width, icon + value sharing one row leaves the
          value under 80px to work with, which forces a duration string
          into 3-4 cramped lines regardless of font size. Stacking gives it
          the card's full width instead, at the cost of the icon sitting a
          line higher; from sm: up (3-column desktop, ~300px+ per card)
          there's room for both side by side, matching the numeric cards. */}
      <div
        className={
          typeof value === 'number'
            ? 'flex min-w-0 items-center gap-3.5'
            : 'flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3.5'
        }
        aria-hidden="true"
      >
        <span className={`flex size-12 shrink-0 items-center justify-center rounded-xl ${t.iconBg} ${t.iconColor}`}>
          <Icon className="size-6" />
        </span>
        {/* Numeric counts (a plain number) stay large -- they're always
            short. String values (compact duration text, e.g. "1 יום, 15
            שעות") get a smaller, tighter size instead of the same 3xl: at
            the same size a duration string reads as oversized/cramped
            against the card's width, where the equivalent 1-2 digit count
            never does. */}
        <div
          className={
            typeof value === 'number'
              ? 'text-3xl font-extrabold leading-none text-text-primary'
              : 'text-xl font-extrabold leading-snug text-text-primary sm:text-2xl'
          }
        >
          {value}
        </div>
      </div>
      <div className="min-w-0" aria-hidden="true">
        {/* No truncate: Hebrew KPI labels/context must wrap on narrow
            screens rather than lose text to an ellipsis. */}
        <div className="text-sm font-bold leading-snug text-text-primary">{label}</div>
        <div className="mt-1 text-xs leading-relaxed text-muted">{context}</div>
      </div>
    </div>
  );
}
