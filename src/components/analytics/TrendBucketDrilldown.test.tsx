// Focused coverage of the drill-down's PRESENTATIONAL logic
// (TrendBucketDrilldownContent, bucketRangeLabel) via plain props -- the
// same strategy ClosureBreakdownPanel already uses.
// The outer TrendBucketDrilldown wrapper's own data-fetching and the actual
// chart click that opens it are NOT exercised here: recharts renders zero
// bars in jsdom (ResponsiveContainer measures a 0x0 container, so there is
// nothing to click), which is exactly why IncidentTrendChart.test.tsx tests
// its click-resolution logic (bucketFromChartClick) as a standalone pure
// function rather than a simulated chart interaction -- see that file's own
// header comment. The end-to-end click -> open -> fetch -> navigate flow is
// verified manually in a real browser (see the polish pass's validation
// notes), not here.
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { bucketRangeLabel, TrendBucketDrilldownContent } from './TrendBucketDrilldown';
import type { AnalyticsBucket } from '../../domain/analyticsSummary';
import type { IncidentSummary, SystemRecord } from '../../domain/types';

function makeIncident(overrides: Partial<IncidentSummary> = {}): IncidentSummary {
  return {
    id: 'i1',
    number: '2026-001',
    severity: 'medium',
    status: 'in_progress',
    systemId: 'sys-1',
    locationId: 'loc-1',
    description: 'תיאור התקלה',
    ...overrides,
  };
}

const systems: SystemRecord[] = [
  { id: 'sys-1', name: 'מערכת אלפא', archived: false, category: 'other', displayOrder: 1, createdAt: '2026-01-01T00:00:00.000Z' },
];

function renderContent(props: Partial<Parameters<typeof TrendBucketDrilldownContent>[0]> = {}) {
  const bucket: AnalyticsBucket = { bucketStart: '2026-08-05', opened: 0, closed: 0, ...props.bucket };
  return render(
    <MemoryRouter>
      <TrendBucketDrilldownContent bucket={bucket} systems={systems} isLoading={false} data={{ opened: [], closed: [] }} {...props} />
    </MemoryRouter>,
  );
}

describe('bucketRangeLabel', () => {
  it('formats a day bucket as DD/MM/YYYY', () => {
    expect(bucketRangeLabel('2026-08-05', 'day')).toBe('05/08/2026');
  });

  it('formats a week bucket within the same month as a compact DD/MM-DD/MM/YYYY range', () => {
    // 2026-08-03 is a Monday; the ISO week runs through 2026-08-09.
    expect(bucketRangeLabel('2026-08-03', 'week')).toBe('שבוע 03/08–09/08/2026');
  });

  it('formats a week bucket crossing a month boundary (still one shared year) with the year shown once, at the end', () => {
    // 2026-08-31 is a Monday; the ISO week runs into September, same year.
    expect(bucketRangeLabel('2026-08-31', 'week')).toBe('שבוע 31/08–06/09/2026');
  });

  it('formats a week bucket crossing a YEAR boundary with the year shown on both ends', () => {
    // 2026-12-28 is a Monday; the ISO week runs into January 2027.
    expect(bucketRangeLabel('2026-12-28', 'week')).toBe('שבוע 28/12/2026–03/01/2027');
  });
});

describe('TrendBucketDrilldownContent: loading state', () => {
  it('shows a spinner while loading or before data has arrived, not an empty section', () => {
    renderContent({ isLoading: true, data: undefined });
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('נפתחו')).not.toBeInTheDocument();
  });
});

describe('TrendBucketDrilldownContent: section counts always come from the bucket, never re-derived', () => {
  it('the "נפתחו"/"נסגרו" headers show the bucket\'s own opened/closed counts, matching the chart exactly', () => {
    renderContent({
      bucket: { bucketStart: '2026-08-05', opened: 2, closed: 1 },
      data: { opened: [makeIncident({ id: 'a' }), makeIncident({ id: 'b' })], closed: [makeIncident({ id: 'c' })] },
    });
    expect(screen.getByText('נפתחו · 2')).toBeInTheDocument();
    expect(screen.getByText('נסגרו · 1')).toBeInTheDocument();
  });
});

describe('TrendBucketDrilldownContent: empty sections', () => {
  it('shows a compact "no incidents" message for a zero-count section rather than disappearing ambiguously', () => {
    renderContent({ bucket: { bucketStart: '2026-08-05', opened: 0, closed: 3 }, data: { opened: [], closed: [makeIncident()] } });
    expect(screen.getByText('לא נפתחו תקלות בפרק הזמן הזה')).toBeInTheDocument();
  });
});

describe('TrendBucketDrilldownContent: incident rows', () => {
  it('renders each row as "#number · system-name" plus a short description, linking to /incidents/{id}', () => {
    renderContent({
      bucket: { bucketStart: '2026-08-05', opened: 1, closed: 0 },
      data: { opened: [makeIncident({ id: 'inc-42', number: '2026-042', systemId: 'sys-1', description: 'תקלה בציוד' })], closed: [] },
    });
    const link = screen.getByRole('link', { name: /2026-042/ });
    expect(link).toHaveAttribute('href', '/incidents/inc-42');
    expect(within(link).getByText('#2026-042')).toBeInTheDocument();
    expect(within(link).getByText('מערכת אלפא')).toBeInTheDocument();
    expect(within(link).getByText('תקלה בציוד')).toBeInTheDocument();
  });

  it('falls back to a placeholder when the system cannot be resolved (e.g. still loading)', () => {
    renderContent({
      bucket: { bucketStart: '2026-08-05', opened: 1, closed: 0 },
      systems: undefined,
      data: { opened: [makeIncident({ systemId: 'unknown-sys' })], closed: [] },
    });
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('TrendBucketDrilldownContent: 3-then-expand truncation', () => {
  const five = Array.from({ length: 5 }, (_, n) => makeIncident({ id: `i${n}`, number: `2026-0${n}` }));

  it('shows only the first 3 incidents initially, with a "+N נוספות" affordance for the rest', () => {
    renderContent({ bucket: { bucketStart: '2026-08-05', opened: 5, closed: 0 }, data: { opened: five, closed: [] } });
    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(screen.getByRole('button', { name: '+2 נוספות' })).toBeInTheDocument();
  });

  it('expanding reveals the rest, contained inside the same panel (no navigation, no new page)', async () => {
    const user = userEvent.setup();
    renderContent({ bucket: { bucketStart: '2026-08-05', opened: 5, closed: 0 }, data: { opened: five, closed: [] } });
    await user.click(screen.getByRole('button', { name: '+2 נוספות' }));
    expect(screen.getAllByRole('link')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: /נוספות/ })).not.toBeInTheDocument();
  });

  it('does not show the expand affordance when there are 3 or fewer incidents', () => {
    renderContent({
      bucket: { bucketStart: '2026-08-05', opened: 2, closed: 0 },
      data: { opened: five.slice(0, 2), closed: [] },
    });
    expect(screen.queryByRole('button', { name: /נוספות/ })).not.toBeInTheDocument();
  });

  it('opened and closed sections expand independently of each other', async () => {
    const user = userEvent.setup();
    renderContent({
      bucket: { bucketStart: '2026-08-05', opened: 5, closed: 5 },
      data: { opened: five, closed: five.map((i) => ({ ...i, id: `closed-${i.id}` })) },
    });
    const openedButton = screen.getAllByRole('button', { name: '+2 נוספות' })[0];
    await user.click(openedButton);
    // Still exactly one remaining expand button (the closed section's own).
    expect(screen.getAllByRole('button', { name: '+2 נוספות' })).toHaveLength(1);
  });
});

describe('TrendBucketDrilldownContent: fetch cap edge case', () => {
  it('shows an honest "מוצגות X מתוך Y" note when the true bucket count exceeds what was fetched, never implying expand reveals everything', () => {
    renderContent({
      bucket: { bucketStart: '2026-08-05', opened: 25, closed: 0 },
      data: { opened: Array.from({ length: 20 }, (_, n) => makeIncident({ id: `i${n}` })), closed: [] },
    });
    expect(screen.getByText('מוצגות 20 מתוך 25')).toBeInTheDocument();
  });
});
