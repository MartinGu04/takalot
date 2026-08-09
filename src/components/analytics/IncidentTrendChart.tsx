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
//
// Drill-down: when `onBucketClick` is passed, clicking anywhere in a
// bucket's column (not just precisely on a bar) selects that whole bucket
// -- recharts' chart-level onClick resolves the nearest x-axis category
// from the pointer position, which is what makes the entire column
// clickable rather than just a few bar pixels. The hover tooltip keeps its
// existing opened/closed content unchanged and only gains one subtle hint
// line ("לחץ לצפייה בתקלות") pointing at that affordance -- the incident
// list itself never lives inside the hover tooltip.
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnalyticsBucket } from '../../domain/analyticsSummary';
import { formatDate } from '../../lib/time';

/** YYYY-MM-DD -> DD/MM. Pure string slicing, not a Date object -- the
 *  bucket key is already an Asia/Jerusalem calendar date, so re-parsing it
 *  through any timezone-aware API risks shifting it by a day. */
function shortDate(bucketStart: string): string {
  return `${bucketStart.slice(8, 10)}/${bucketStart.slice(5, 7)}`;
}

type TrendDatum = AnalyticsBucket & { label: string };

/** Resolves recharts' chart-level click state (an activeIndex into the
 *  SAME `data` array the chart was rendered from) to the plain
 *  AnalyticsBucket the user clicked -- kept as a small, directly-testable
 *  pure function since simulating recharts' real mouse-position hit-testing
 *  (which depends on getBoundingClientRect layout jsdom doesn't provide)
 *  isn't reliable to exercise through the rendered SVG itself.
 *
 *  recharts v3's `activeIndex` is typed `number | TooltipIndex | undefined`
 *  (`TooltipIndex = string | null`), but at runtime it is always a numeric
 *  STRING (e.g. `"3"`) or `null`/`undefined` -- never an actual `number`
 *  (verified against `combineActiveTooltipIndex`, which always returns
 *  `String(clampedIndex)`). A `typeof === 'number'` guard therefore never
 *  matches; this parses whatever shape arrives instead. */
export function bucketFromChartClick(
  data: TrendDatum[],
  activeIndex: number | string | null | undefined,
): AnalyticsBucket | null {
  if (activeIndex === null || activeIndex === undefined) return null;
  const index = typeof activeIndex === 'number' ? activeIndex : Number(activeIndex);
  if (!Number.isInteger(index)) return null;
  const point = data[index];
  return point ? { bucketStart: point.bucketStart, opened: point.opened, closed: point.closed } : null;
}

export function TrendTooltipContent({
  active,
  payload,
  label,
  showHint,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string; value?: number }>;
  label?: string;
  showHint: boolean;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div
      style={{
        direction: 'rtl',
        textAlign: 'right',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-hairline)',
        borderRadius: 8,
        fontSize: 12,
        padding: '8px 10px',
      }}
    >
      <p style={{ margin: 0, marginBottom: 4, fontWeight: 600 }}>{label}</p>
      {payload.map((entry) => (
        <p key={entry.dataKey} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: entry.dataKey === 'opened' ? 'var(--color-brand-500)' : 'var(--color-emerald-500)',
            }}
          />
          {entry.dataKey === 'opened' ? 'נפתחו' : 'נסגרו'}: {entry.value}
        </p>
      ))}
      {showHint && (
        <p style={{ margin: 0, marginTop: 6, fontSize: 11, color: 'var(--color-text-muted)' }}>לחץ לצפייה בתקלות</p>
      )}
    </div>
  );
}

export function IncidentTrendChart({
  buckets,
  onBucketClick,
}: {
  buckets: AnalyticsBucket[];
  /** When provided, every bucket becomes clickable (pointer cursor over
   *  the whole chart, "לחץ לצפייה בתקלות" hint in the tooltip) and this
   *  fires with the exact bucket the user selected. */
  onBucketClick?: (bucket: AnalyticsBucket) => void;
}) {
  const data: TrendDatum[] = buckets.map((b) => ({ ...b, label: shortDate(b.bucketStart) }));
  return (
    <>
      {/* Below sm: (mobile), the chart gets a fixed min-width and its own
          horizontal scroll instead of being squeezed into the full
          viewport width -- with up to 30 daily buckets (60 bars counting
          both series), squeezing everything into ~340px left each bar only
          a couple of pixels wide and crowded the date labels. ~660px of
          real width instead gives recharts' own auto bar-sizing and
          tick-collision avoidance (interval="preserveStartEnd", unchanged
          below) much more room to work with -- which is what actually
          thickens the bars and thins out the x-axis labels, with no
          bucket-count-specific logic needed. At sm: and up, both the
          min-width and the scrolling are switched off (min-w-0,
          overflow-visible), so desktop and tablet render exactly as
          before -- this only ever affects the narrow mobile case. */}
      <div className="relative">
        <div dir="ltr" className="w-full overflow-x-auto sm:overflow-visible" aria-hidden="true">
          <div className="h-64 min-w-[660px] sm:h-80 sm:min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data}
                margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                accessibilityLayer={false}
                // recharts' own wrapper sets an inline `cursor: 'default'`
                // style, which a `cursor-pointer` CLASS can never win
                // against (inline style always beats a class in the
                // cascade) -- passed as `style` instead, which recharts
                // merges on top of its own default, so this actually wins.
                style={onBucketClick ? { cursor: 'pointer' } : undefined}
                className={onBucketClick ? 'cursor-pointer' : undefined}
                onClick={(state) => {
                  if (!onBucketClick) return;
                  const bucket = bucketFromChartClick(data, state?.activeIndex);
                  if (bucket) onBucketClick(bucket);
                }}
              >
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
                <Tooltip content={<TrendTooltipContent showHint={!!onBucketClick} />} />
                <Legend
                  formatter={(name) => (name === 'opened' ? 'נפתחו' : 'נסגרו')}
                  wrapperStyle={{ direction: 'rtl', fontSize: 12 }}
                />
                {/* opened: brand purple, matching the KPI cards' neutral-brand
                    tone; closed: a cool emerald green, clearly distinguishable
                    from purple at a glance and consistent with the KPI cards'
                    green "נסגרו בתקופה" tone -- not the previous neutral gray,
                    which read as "no meaning," not "closed." */}
                <Bar dataKey="opened" name="opened" fill="var(--color-brand-500)" radius={[3, 3, 0, 0]} />
                <Bar dataKey="closed" name="closed" fill="var(--color-emerald-500)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        {/* Subtle scroll affordance, mobile-only: a soft fade at the
            trailing edge (matching the chart's own ltr orientation) hints
            that more of the timeline is reachable by scrolling, without
            adding any extra label text or clutter. */}
        <div
          className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-surface to-transparent sm:hidden"
          aria-hidden="true"
        />
      </div>
      {/* sr-only on the wrapping div, not the <table> itself: a <table>'s
          own auto-layout content sizing (driven by its cells' natural
          width, and up to 90 rows for the 90-day period) overrides the
          clip-based sr-only technique's width:1px/height:1px when applied
          directly to a table element, silently rendering it at full size
          and inflating the page's real height. A block-level div has no
          such special sizing behavior and reliably clips its table child. */}
      <div className="sr-only">
        <table>
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
      </div>
    </>
  );
}
