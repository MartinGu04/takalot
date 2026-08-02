// "פתיחת וסגירת תקלות" -- opened vs closed incident counts over time.
// Buckets arrive already zero-filled from the RPC/domain layer, so this
// chart always has something to render (no dedicated empty state needed).
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnalyticsBucket } from '../../domain/analyticsSummary';

/** YYYY-MM-DD -> DD/MM. Pure string slicing, not a Date object -- the
 *  bucket key is already an Asia/Jerusalem calendar date, so re-parsing it
 *  through any timezone-aware API risks shifting it by a day. */
function shortDate(bucketStart: string): string {
  return `${bucketStart.slice(8, 10)}/${bucketStart.slice(5, 7)}`;
}

export function IncidentTrendChart({ buckets }: { buckets: AnalyticsBucket[] }) {
  const data = buckets.map((b) => ({ ...b, label: shortDate(b.bucketStart) }));
  return (
    <div dir="ltr" className="h-64 w-full sm:h-80">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
  );
}
