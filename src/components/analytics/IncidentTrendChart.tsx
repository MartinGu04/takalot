// "פתיחת וסגירת תקלות" -- opened vs closed incident counts over time.
// Buckets arrive already zero-filled from the RPC/domain layer, so this
// chart always has something to render (no dedicated empty state needed).
//
// Accessibility: the visual Recharts SVG is hidden from assistive
// technology (aria-hidden, accessibilityLayer={false} to also drop
// recharts' own auto-generated role="application"/tabIndex layer -- a
// focusable element left inside an aria-hidden ancestor is a real trap for
// keyboard users, not just a screen-reader gap). The actual data is
// exposed instead via a visually-hidden (`sr-only`) table with the same
// per-bucket opened/closed counts a sighted user reads off the bars --
// this is the single accessible representation, not a duplicate one.
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnalyticsBucket } from '../../domain/analyticsSummary';
import { formatDate } from '../../lib/time';

/** YYYY-MM-DD -> DD/MM. Pure string slicing, not a Date object -- the
 *  bucket key is already an Asia/Jerusalem calendar date, so re-parsing it
 *  through any timezone-aware API risks shifting it by a day. */
function shortDate(bucketStart: string): string {
  return `${bucketStart.slice(8, 10)}/${bucketStart.slice(5, 7)}`;
}

export function IncidentTrendChart({ buckets }: { buckets: AnalyticsBucket[] }) {
  const data = buckets.map((b) => ({ ...b, label: shortDate(b.bucketStart) }));
  return (
    <>
      <div dir="ltr" className="h-64 w-full sm:h-80" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} accessibilityLayer={false}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-hairline)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
              tickLine={false}
              axisLine={{ stroke: 'var(--color-hairline)' }}
              interval="preserveStartEnd"
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
              formatter={(value, name) => [String(value), name === 'opened' ? 'נפתחו' : 'נסגרו']}
            />
            <Legend
              formatter={(name) => (name === 'opened' ? 'נפתחו' : 'נסגרו')}
              wrapperStyle={{ direction: 'rtl', fontSize: 12 }}
            />
            <Bar dataKey="opened" name="opened" fill="var(--color-brand-500)" radius={[3, 3, 0, 0]} />
            <Bar dataKey="closed" name="closed" fill="var(--color-slate-400)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>נתוני פתיחה וסגירת תקלות לפי תקופה, יום או שבוע</caption>
        <thead>
          <tr>
            <th scope="col">תאריך</th>
            <th scope="col">נפתחו</th>
            <th scope="col">נסגרו</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.bucketStart}>
              <td>{formatDate(b.bucketStart)}</td>
              <td>{b.opened}</td>
              <td>{b.closed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
