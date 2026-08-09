// Shared compact ranking panel for the ניתוחים (analytics) page's top-5
// system/location lists. One surface container with compact rows separated
// by dividers (the same idiom as DashboardPage's "נסגרו לאחרונה" list and
// PersonnelPage's rows), not one large standalone card per entity -- a
// column-header row states each metric's label once, so individual rows
// stay to a single compact line of aligned values instead of repeating
// three labeled mini-stat blocks per row.
//
// v1.4.0: the duration column is MEDIAN close time, not average -- the page
// standardized on median as the resolution-time concept (see
// AnalyticsKpiCard) precisely because averages are skewed by outliers, and
// that reasoning applies here too. No per-row average is shown any more.
import type { ReactNode } from 'react';
import { formatDurationMinutes } from '../../lib/time';
import { EmptyState } from '../ui';

export interface RankingRow {
  id: string;
  name: string;
  openedInPeriod: number;
  currentlyOpen: number;
  medianCloseMinutes: number | null;
}

const COLUMN_LABELS = {
  openedInPeriod: 'נפתחו בתקופה',
  currentlyOpen: 'פתוחות כעת',
  medianCloseMinutes: 'זמן טיפול חציוני',
};

export function RankingList({ rows, emptyTitle }: { rows: RankingRow[]; emptyTitle: string }) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} />;
  }
  return (
    <div className="surface overflow-hidden">
      {/* Column headers -- desktop (sm:+) only. Below sm: each row becomes
          self-labeling (see the two-line mobile layout below), so a shared
          header row would just repeat labels already shown per-row. */}
      <div className="hidden items-center gap-x-3 gap-y-1 border-b border-hairline px-3 py-2 text-xs font-medium text-muted sm:flex">
        <span className="w-6 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">שם</span>
        <span className="w-16 shrink-0 text-center">{COLUMN_LABELS.openedInPeriod}</span>
        <span className="w-16 shrink-0 text-center">{COLUMN_LABELS.currentlyOpen}</span>
        <span className="w-32 shrink-0 text-center">{COLUMN_LABELS.medianCloseMinutes}</span>
      </div>
      <div className="divide-y divide-hairline">
        {rows.map((row, index) => (
          <div key={row.id} className="px-3 py-2.5">
            {/* Desktop (sm:+): one line, unchanged pixel-for-pixel from
                before this fix -- three fixed-width metric columns squeeze
                the name column here, which is fine once there's enough
                width for all four to coexist. Below sm: that squeeze was the
                bug (Hebrew names collapsing to 1-2 visible characters), so
                mobile gets its own, non-squeezed two-line layout instead
                (see below) rather than shrinking these columns further. */}
            <div className="hidden items-center gap-x-3 gap-y-1 sm:flex" data-testid="ranking-row-desktop">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-active text-xs font-bold text-text-secondary">
                {index + 1}
              </span>
              {/* Dominant, but still yields to the metric columns beside it --
                  truncates with a title tooltip rather than pushing the
                  numbers off, matching the owner-name pattern already used
                  on incident cards (IncidentCard/incident.tsx). Only safe
                  here because sm:+ has the width for four columns to
                  coexist without squeezing the name to nothing. */}
              <span className="min-w-0 flex-1 truncate text-sm font-bold text-text-primary" title={row.name}>
                {row.name}
              </span>
              <RankingValue className="w-16 text-center">{row.openedInPeriod}</RankingValue>
              <RankingValue className="w-16 text-center">{row.currentlyOpen}</RankingValue>
              {/* Duration values are never truncated: no truncate/nowrap
                  here, only wrap -- "2 ימים, 8 שעות" must stay fully
                  readable even if it wraps onto a second line. */}
              <RankingValue className="w-32 whitespace-normal break-words text-center">
                {formatDurationMinutes(row.medianCloseMinutes)}
              </RankingValue>
            </div>

            {/* Mobile (<sm): two lines. The name is the row's identifying
                field, so -- matching IncidentCard's own established
                convention that identifying fields must WRAP, never
                truncate -- it gets the full row width on its own line
                (no truncate, no title fallback: the text itself is always
                fully visible). The three metrics reflow onto a second,
                self-labeled line instead of competing with the name for
                width, indented (ps-9) to align under the name past the
                rank badge. */}
            <div className="flex flex-col gap-1 sm:hidden" data-testid="ranking-row-mobile">
              <div className="flex items-center gap-x-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-active text-xs font-bold text-text-secondary">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 break-words text-sm font-bold text-text-primary">{row.name}</span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 ps-9 text-xs text-muted">
                <span>
                  {COLUMN_LABELS.openedInPeriod}: <span className="font-semibold text-text-primary">{row.openedInPeriod}</span>
                </span>
                <span>
                  {COLUMN_LABELS.currentlyOpen}: <span className="font-semibold text-text-primary">{row.currentlyOpen}</span>
                </span>
                <span>
                  {COLUMN_LABELS.medianCloseMinutes}:{' '}
                  <span className="font-semibold text-text-primary">{formatDurationMinutes(row.medianCloseMinutes)}</span>
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RankingValue({ className, children }: { className: string; children: ReactNode }) {
  return <span className={`shrink-0 text-sm font-semibold text-text-primary ${className}`}>{children}</span>;
}
