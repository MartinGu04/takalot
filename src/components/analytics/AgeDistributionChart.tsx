// "גיל תקלות פתוחות" -- how old is the CURRENT backlog. Answers "one stale
// outlier or a systemic pile-up," which a single average age (already
// shown in the KPI row) cannot: this shows the actual distribution across
// 5 fixed age bands. Deliberately NOT period-bound (see
// analyticsOpenBacklog.ts) -- the period filter never affects this module.
//
// Same accessibility pattern as IncidentTrendChart: the visual Recharts SVG
// is hidden from assistive technology; the real data is exposed via a
// visually-hidden (sr-only) table instead.
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnalyticsBacklogBand, AnalyticsBacklogBandKey, IncidentOpenBacklog } from '../../domain/analyticsOpenBacklog';
import { EmptyState } from '../ui';

const BAND_LABELS: Record<AnalyticsBacklogBandKey, string> = {
  lt_1d: 'פחות מיום',
  '1_3d': '1–3 ימים',
  '3_7d': '3–7 ימים',
  '7_14d': '7–14 ימים',
  gt_14d: 'מעל 14 יום',
};

const BAND_ORDER: AnalyticsBacklogBandKey[] = ['lt_1d', '1_3d', '3_7d', '7_14d', 'gt_14d'];

function orderedBands(bands: AnalyticsBacklogBand[]): AnalyticsBacklogBand[] {
  const byKey = new Map(bands.map((b) => [b.band, b]));
  return BAND_ORDER.map((key) => byKey.get(key) ?? { band: key, count: 0 });
}

export function AgeDistributionChart({ backlog }: { backlog: IncidentOpenBacklog }) {
  if (backlog.currentlyOpen === 0) {
    // A GOOD empty state -- zero backlog is good news, must not look broken.
    return <EmptyState title="אין תקלות פתוחות התואמות את הסינון הנוכחי" />;
  }

  const bands = orderedBands(backlog.bands);
  const data = bands.map((b) => ({ ...b, label: BAND_LABELS[b.band] }));

  return (
    <>
      <div className="h-56 sm:h-64" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} accessibilityLayer={false}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-hairline)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
              tickLine={false}
              axisLine={{ stroke: 'var(--color-hairline)' }}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
              tickLine={false}
              axisLine={false}
              width={28}
            />
            <Tooltip
              contentStyle={{
                direction: 'rtl',
                textAlign: 'right',
                background: 'var(--color-surface)',
                border: '1px solid var(--color-hairline)',
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value) => [String(value), 'תקלות פתוחות']}
            />
            <Bar dataKey="count" name="count" fill="var(--color-orange-500)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="sr-only">
        <table>
          <caption>התפלגות גיל התקלות הפתוחות הנוכחיות</caption>
          <thead>
            <tr>
              <th scope="col">טווח גיל</th>
              <th scope="col">מספר תקלות</th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b) => (
              <tr key={b.band}>
                <td>{BAND_LABELS[b.band]}</td>
                <td>{b.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
