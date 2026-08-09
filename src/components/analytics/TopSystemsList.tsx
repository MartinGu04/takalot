// "מערכות עם הכי הרבה תקלות" -- top 5 systems for the selected period,
// ranked by incidents opened in it. A thin adapter over the shared
// RankingList (see that file for the compact row layout itself).
import type { AnalyticsSystemRow } from '../../domain/analyticsSummary';
import { RankingList } from './RankingList';

export function TopSystemsList({ rows }: { rows: AnalyticsSystemRow[] }) {
  return (
    <RankingList
      rows={rows.map((row) => ({
        id: row.systemId,
        name: row.systemName,
        openedInPeriod: row.openedInPeriod,
        currentlyOpen: row.currentlyOpen,
        medianCloseMinutes: row.medianCloseMinutes,
      }))}
      emptyTitle="אין מערכות עם תקלות בתקופה שנבחרה"
    />
  );
}
