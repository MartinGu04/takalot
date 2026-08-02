// RankingList (and its TopSystemsList/TopLocationsList adapters): the
// compact ranking panel for the ניתוחים analytics page's top-5 system and
// location lists, replacing the former one-large-card-per-entity layout.
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RankingList, type RankingRow } from './RankingList';
import { TopSystemsList } from './TopSystemsList';
import { TopLocationsList } from './TopLocationsList';
import type { AnalyticsSystemRow, AnalyticsLocationRow } from '../../domain/analyticsSummary';

function makeRow(overrides: Partial<RankingRow> = {}): RankingRow {
  return {
    id: 'r1',
    name: 'ישות לדוגמה',
    openedInPeriod: 7,
    currentlyOpen: 1,
    avgCloseMinutes: 3320, // 2 days, 7h20m -> formatDurationMinutes caps at 2 components
    ...overrides,
  };
}

describe('RankingList: compact rows, not one large card per entity', () => {
  it('shows the three metric labels exactly once each (as column headers), not once per row', () => {
    const rows = [makeRow({ id: 'a', name: 'A' }), makeRow({ id: 'b', name: 'B' }), makeRow({ id: 'c', name: 'C' })];
    render(<RankingList rows={rows} emptyTitle="אין נתונים" />);
    expect(screen.getAllByText('נפתחו בתקופה')).toHaveLength(1);
    expect(screen.getAllByText('פתוחות כעת')).toHaveLength(1);
    expect(screen.getAllByText('זמן סגירה ממוצע')).toHaveLength(1);
  });

  it('renders rank, name and the three values for each row', () => {
    // Metric values deliberately avoid 1/2 so they can't collide with the
    // rank badges themselves when queried by exact text.
    const rows = [
      makeRow({ id: 'sys-1', name: 'מערכת ראשונה', openedInPeriod: 7, currentlyOpen: 4 }),
      makeRow({ id: 'sys-2', name: 'מערכת שנייה', openedInPeriod: 9, currentlyOpen: 5 }),
    ];
    render(<RankingList rows={rows} emptyTitle="אין נתונים" />);
    const firstRow = screen.getByText('מערכת ראשונה').closest('div') as HTMLElement;
    expect(within(firstRow).getByText('1')).toBeInTheDocument(); // rank
    const secondRow = screen.getByText('מערכת שנייה').closest('div') as HTMLElement;
    expect(within(secondRow).getByText('2')).toBeInTheDocument(); // rank
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('does not render one surface card per row -- exactly one shared surface container for the whole panel', () => {
    const rows = [makeRow({ id: 'a' }), makeRow({ id: 'b' }), makeRow({ id: 'c' })];
    const { container } = render(<RankingList rows={rows} emptyTitle="אין נתונים" />);
    expect(container.querySelectorAll('.surface')).toHaveLength(1);
  });

  it('a long entity name truncates with an accessible title tooltip, rather than breaking the row layout', () => {
    const longName = 'שם מערכת ארוך מאוד מאוד מאוד שאמור להיחתך ולא לשבור את הפריסה של השורה הקומפקטית';
    render(<RankingList rows={[makeRow({ name: longName })]} emptyTitle="אין נתונים" />);
    const nameEl = screen.getByText(longName);
    expect(nameEl).toHaveClass('truncate');
    expect(nameEl).toHaveAttribute('title', longName);
  });

  it('a duration value is never truncated -- the full formatted string is always present in the DOM', () => {
    // formatDurationMinutes(3320) = "2 ימים, 7 שעות" (see src/lib/time.ts).
    render(<RankingList rows={[makeRow({ avgCloseMinutes: 3320 })]} emptyTitle="אין נתונים" />);
    const durationEl = screen.getByText('2 ימים, 7 שעות');
    expect(durationEl).not.toHaveClass('truncate');
  });

  it('shows the given empty-state title and no rows when there is nothing to rank', () => {
    render(<RankingList rows={[]} emptyTitle="אין מערכות עם תקלות בתקופה שנבחרה" />);
    expect(screen.getByText('אין מערכות עם תקלות בתקופה שנבחרה')).toBeInTheDocument();
    expect(screen.queryByText('נפתחו בתקופה')).not.toBeInTheDocument();
  });

  it('null avgCloseMinutes renders the standard placeholder, matching every other duration display on the page', () => {
    render(<RankingList rows={[makeRow({ avgCloseMinutes: null })]} emptyTitle="אין נתונים" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('TopSystemsList / TopLocationsList: thin adapters over RankingList', () => {
  function makeSystemRow(overrides: Partial<AnalyticsSystemRow> = {}): AnalyticsSystemRow {
    return {
      systemId: 'sys-1',
      systemName: 'מערכת אלפא',
      openedInPeriod: 5,
      currentlyOpen: 2,
      avgCloseMinutes: 120,
      ...overrides,
    };
  }
  function makeLocationRow(overrides: Partial<AnalyticsLocationRow> = {}): AnalyticsLocationRow {
    return {
      locationId: 'loc-1',
      locationName: 'אתר 1',
      openedInPeriod: 4,
      currentlyOpen: 1,
      avgCloseMinutes: 90,
      ...overrides,
    };
  }

  it('TopSystemsList renders each system row with its own empty-state text', () => {
    render(<TopSystemsList rows={[makeSystemRow()]} />);
    expect(screen.getByText('מערכת אלפא')).toBeInTheDocument();

    render(<TopSystemsList rows={[]} />);
    expect(screen.getByText('אין מערכות עם תקלות בתקופה שנבחרה')).toBeInTheDocument();
  });

  it('TopLocationsList renders each location row with its own empty-state text', () => {
    render(<TopLocationsList rows={[makeLocationRow()]} />);
    expect(screen.getByText('אתר 1')).toBeInTheDocument();

    render(<TopLocationsList rows={[]} />);
    expect(screen.getByText('אין מיקומים עם תקלות בתקופה שנבחרה')).toBeInTheDocument();
  });

  it('an empty panel does not hide a sibling panel that has data -- each renders its own independent state', () => {
    render(
      <div>
        <div data-testid="systems-panel">
          <TopSystemsList rows={[]} />
        </div>
        <div data-testid="locations-panel">
          <TopLocationsList rows={[makeLocationRow({ locationName: 'אתר עם תקלות' })]} />
        </div>
      </div>,
    );
    expect(within(screen.getByTestId('systems-panel')).getByText('אין מערכות עם תקלות בתקופה שנבחרה')).toBeInTheDocument();
    expect(within(screen.getByTestId('locations-panel')).getByText('אתר עם תקלות')).toBeInTheDocument();
  });
});
