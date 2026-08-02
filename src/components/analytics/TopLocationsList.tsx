// "מיקומים עם הכי הרבה תקלות" -- top 5 locations for the selected period,
// ranked by incidents opened in it. A thin adapter over the shared
// RankingList (see that file for the compact row layout itself), mirroring
// TopSystemsList exactly.
import type { AnalyticsLocationRow } from '../../domain/analyticsSummary';
import { RankingList } from './RankingList';

export function TopLocationsList({ rows }: { rows: AnalyticsLocationRow[] }) {
  return (
    <RankingList
      rows={rows.map((row) => ({
        id: row.locationId,
        name: row.locationName,
        openedInPeriod: row.openedInPeriod,
        currentlyOpen: row.currentlyOpen,
        avgCloseMinutes: row.avgCloseMinutes,
      }))}
      emptyTitle="אין מיקומים עם תקלות בתקופה שנבחרה"
    />
  );
}
