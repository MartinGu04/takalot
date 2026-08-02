// Shared compact ranking panel for the ניתוחים (analytics) page's top-5
// system/location lists. One surface container with compact rows separated
// by dividers (the same idiom as DashboardPage's "נסגרו לאחרונה" list and
// PersonnelPage's rows), not one large standalone card per entity -- a
// column-header row states each metric's label once, so individual rows
// stay to a single compact line of aligned values instead of repeating
// three labeled mini-stat blocks per row.
import type { ReactNode } from 'react';
import { formatDurationMinutes } from '../../lib/time';
import { EmptyState } from '../ui';

export interface RankingRow {
  id: string;
  name: string;
  openedInPeriod: number;
  currentlyOpen: number;
  avgCloseMinutes: number | null;
}

const COLUMN_LABELS = {
  openedInPeriod: 'נפתחו בתקופה',
  currentlyOpen: 'פתוחות כעת',
  avgCloseMinutes: 'זמן סגירה ממוצע',
};

export function RankingList({ rows, emptyTitle }: { rows: RankingRow[]; emptyTitle: string }) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} />;
  }
  return (
    <div className="surface overflow-hidden">
      {/* Column headers: stated once per panel, not repeated per row --
          this is what keeps each row down to rank + dominant name + three
          plain aligned values instead of three nested labeled stat cards. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline px-3 py-2 text-xs font-medium text-muted">
        <span className="w-6 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">שם</span>
        <span className="w-16 shrink-0 text-center">{COLUMN_LABELS.openedInPeriod}</span>
        <span className="w-16 shrink-0 text-center">{COLUMN_LABELS.currentlyOpen}</span>
        <span className="w-32 shrink-0 text-center">{COLUMN_LABELS.avgCloseMinutes}</span>
      </div>
      <div className="divide-y divide-hairline">
        {rows.map((row, index) => (
          <div key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-active text-xs font-bold text-text-secondary">
              {index + 1}
            </span>
            {/* Dominant, but still yields to the metric columns beside it --
                truncates with a title tooltip rather than pushing the
                numbers off narrow widths, matching the owner-name pattern
                already used on incident cards (IncidentCard/incident.tsx). */}
            <span className="min-w-0 flex-1 truncate text-sm font-bold text-text-primary" title={row.name}>
              {row.name}
            </span>
            <RankingValue className="w-16 text-center">{row.openedInPeriod}</RankingValue>
            <RankingValue className="w-16 text-center">{row.currentlyOpen}</RankingValue>
            {/* Duration values are never truncated: no truncate/nowrap here,
                only wrap -- "2 ימים, 8 שעות" must stay fully readable even
                if it wraps onto a second line inside its column. */}
            <RankingValue className="w-32 whitespace-normal break-words text-center">
              {formatDurationMinutes(row.avgCloseMinutes)}
            </RankingValue>
          </div>
        ))}
      </div>
    </div>
  );
}

function RankingValue({ className, children }: { className: string; children: ReactNode }) {
  return <span className={`shrink-0 text-sm font-semibold text-text-primary ${className}`}>{children}</span>;
}
