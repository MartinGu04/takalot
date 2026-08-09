// Click-to-drill-down detail view for one פתיחת וסגירת תקלות (trend chart)
// bucket -- "לחץ לצפייה בתקלות" from IncidentTrendChart's tooltip hint.
// Desktop: a compact anchored FloatingPopover near the chart. Mobile: the
// existing Dialog primitive, which auto-renders as a bottom sheet there
// (same mechanism as every other AVARIA mobile sheet). Both share the same
// inner content (TrendBucketDrilldownContent) so the two surfaces can never
// drift apart.
//
// Data-correctness contract (see analyticsTrendDrilldown.ts and
// getAnalyticsTrendBucketIncidents): the section header counts always come
// from `bucket` itself -- the SAME AnalyticsBucket object the chart already
// rendered its bar heights from -- never a second, independently-fetched
// total. Only the individual incident rows (up to
// TREND_BUCKET_DRILLDOWN_LIMIT per section) are fetched on demand. This is
// what guarantees the drill-down can never show a count that contradicts
// the chart it was opened from.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { useAnalyticsTrendBucketIncidents } from '../../data/hooks';
import { addDays, type AnalyticsBucket, type AnalyticsBucketUnit, type AnalyticsEntityFilters } from '../../domain/analyticsSummary';
import type { IncidentSummary, SystemRecord } from '../../domain/types';
import { Dialog, Spinner } from '../ui';
import { FloatingPopover } from '../FloatingPopover';

/** `YYYY-MM-DD` (day) or the ISO-week Monday key -> a clear Hebrew label.
 *  Pure string slicing/arithmetic (addDays), never a timezone-aware Date
 *  API -- bucketStart is already an Asia/Jerusalem calendar-date key, and
 *  re-parsing it through `new Date(...)`/Intl risks shifting it by a day
 *  (same trap IncidentTrendChart's own shortDate() avoids). */
export function bucketRangeLabel(bucketStart: string, bucketUnit: AnalyticsBucketUnit): string {
  const [y, m, d] = bucketStart.split('-');
  if (bucketUnit === 'day') return `${d}/${m}/${y}`;
  const weekEnd = addDays(bucketStart, 6);
  const [ye, me, de] = weekEnd.split('-');
  const startLabel = y === ye ? `${d}/${m}` : `${d}/${m}/${y}`;
  return `שבוע ${startLabel}–${de}/${me}/${ye}`;
}

function useIsDesktopViewport(): boolean {
  const query = '(min-width: 640px)'; // matches Tailwind's sm: breakpoint, used throughout this page's own desktop/mobile split
  const [isDesktop, setIsDesktop] = useState(() => (typeof window === 'undefined' ? true : window.matchMedia(query).matches));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = () => setIsDesktop(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return isDesktop;
}

function IncidentSummaryRow({ incident, systems }: { incident: IncidentSummary; systems?: SystemRecord[] }) {
  const systemName = systems?.find((s) => s.id === incident.systemId)?.name ?? '—';
  return (
    <Link
      to={`/incidents/${incident.id}`}
      className="block min-w-0 rounded-lg px-2 py-1.5 hover:bg-surface-hover"
    >
      <div className="flex min-w-0 items-baseline gap-1.5 text-sm">
        <span className="shrink-0 font-bold text-brand-700 dark:text-brand-400">#{incident.number}</span>
        <span aria-hidden="true" className="shrink-0 text-muted">
          ·
        </span>
        <span className="min-w-0 truncate text-text-secondary">{systemName}</span>
      </div>
      {/* No truncate on the identifying number/system line above (matches
          the app's own wrap-don't-truncate convention for identifying
          fields), but the secondary description line truncates -- same
          split RelatedIncidentsSection already uses. */}
      <p className="mt-0.5 truncate text-xs text-muted" dir="auto">
        {incident.description}
      </p>
    </Link>
  );
}

function BucketSection({
  title,
  count,
  items,
  emptyText,
  systems,
}: {
  title: string;
  count: number;
  items: IncidentSummary[];
  emptyText: string;
  systems?: SystemRecord[];
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, 3);
  const hiddenFetchedCount = items.length - shown.length;

  return (
    <div>
      <h4 className="text-sm font-bold text-text-primary">
        {title} · {count}
      </h4>
      {count === 0 ? (
        <p className="mt-1 text-xs text-muted">{emptyText}</p>
      ) : (
        <>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {shown.map((incident) => (
              <li key={incident.id}>
                <IncidentSummaryRow incident={incident} systems={systems} />
              </li>
            ))}
          </ul>
          {hiddenFetchedCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-1 px-2 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
            >
              +{hiddenFetchedCount} נוספות
            </button>
          )}
          {/* Rare edge case: this bucket genuinely has more incidents than
              the bounded fetch cap. Never silently implied as "expand
              reveals everything" -- says exactly what's shown. */}
          {items.length < count && (
            <p className="mt-1 px-2 text-xs text-muted">
              מוצגות {items.length} מתוך {count}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function TrendBucketDrilldownContent({
  bucket,
  systems,
  isLoading,
  data,
}: {
  bucket: AnalyticsBucket;
  systems?: SystemRecord[];
  isLoading: boolean;
  data: { opened: IncidentSummary[]; closed: IncidentSummary[] } | undefined;
}) {
  return (
    <div className="flex flex-col gap-4">
      {isLoading || !data ? (
        <Spinner label="טוען תקלות…" />
      ) : (
        <>
          <BucketSection
            title="נפתחו"
            count={bucket.opened}
            items={data.opened}
            emptyText="לא נפתחו תקלות בפרק הזמן הזה"
            systems={systems}
          />
          <BucketSection
            title="נסגרו"
            count={bucket.closed}
            items={data.closed}
            emptyText="לא נסגרו תקלות בפרק הזמן הזה"
            systems={systems}
          />
        </>
      )}
    </div>
  );
}

export function TrendBucketDrilldown({
  bucket,
  bucketUnit,
  entityFilters,
  systems,
  anchorRef,
  onClose,
}: {
  /** `null` means closed -- nothing rendered, nothing fetched. */
  bucket: AnalyticsBucket | null;
  bucketUnit: AnalyticsBucketUnit;
  entityFilters: AnalyticsEntityFilters;
  systems?: SystemRecord[];
  /** Anchor for the desktop popover -- the chart's own surrounding surface
   *  card, not an attempt to pin the exact clicked bar (recharts doesn't
   *  expose stable per-bar refs), which still reads as "anchored near the
   *  chart" per the design brief. */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const isDesktop = useIsDesktopViewport();
  const panelRef = useRef<HTMLDivElement>(null);
  const { data, isLoading } = useAnalyticsTrendBucketIncidents(bucket?.bucketStart ?? null, bucketUnit, entityFilters);

  const desktopOpen = bucket !== null && isDesktop;
  const mobileOpen = bucket !== null && !isDesktop;

  // Outside-click / Escape close for the desktop popover -- FloatingPopover
  // itself only computes position, exactly like every other FloatingPopover
  // consumer in this app (see ExportMenu/ArchiveDateFilter).
  useEffect(() => {
    if (!desktopOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!anchorRef.current?.contains(target) && !panelRef.current?.contains(target)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [desktopOpen, anchorRef, onClose]);

  const label = bucket ? bucketRangeLabel(bucket.bucketStart, bucketUnit) : '';

  return (
    <>
      <FloatingPopover
        anchorRef={anchorRef}
        panelRef={panelRef}
        open={desktopOpen}
        width={360}
        maxHeight={440}
        className="popover-panel z-50 animate-scale-in p-3.5"
      >
        {bucket && (
          <div>
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-text-primary">{label}</h3>
              <button
                type="button"
                onClick={onClose}
                aria-label="סגירה"
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover"
              >
                ✕
              </button>
            </div>
            <TrendBucketDrilldownContent bucket={bucket} systems={systems} isLoading={isLoading} data={data} />
          </div>
        )}
      </FloatingPopover>
      <Dialog open={mobileOpen} onClose={onClose} title={label || 'פרטי תקלות'}>
        {bucket && (
          <TrendBucketDrilldownContent bucket={bucket} systems={systems} isLoading={isLoading} data={data} />
        )}
      </Dialog>
    </>
  );
}
