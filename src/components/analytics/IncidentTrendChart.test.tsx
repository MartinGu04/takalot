// Focused accessibility coverage: the visual Recharts SVG must be hidden
// from assistive technology, and the same per-bucket data must be
// available through an accessible (sr-only) table instead -- not both, and
// not neither.
//
// Drill-down click resolution/tooltip content are tested as small, directly
// callable/renderable units rather than by simulating a real recharts mouse
// click on the SVG -- recharts' own hit-testing depends on
// getBoundingClientRect layout math jsdom doesn't provide, so that
// interaction is verified visually/manually instead (see the final polish
// pass's validation notes), matching this file's existing choice to test
// the accessible table rather than simulated chart interactions.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { bucketFromChartClick, IncidentTrendChart, TrendTooltipContent } from './IncidentTrendChart';
import type { AnalyticsBucket } from '../../domain/analyticsSummary';

const buckets: AnalyticsBucket[] = [
  { bucketStart: '2026-07-27', opened: 2, closed: 0 },
  { bucketStart: '2026-07-28', opened: 0, closed: 1 },
  { bucketStart: '2026-08-02', opened: 1, closed: 3 },
];

describe('IncidentTrendChart accessibility', () => {
  it('exposes the same per-bucket opened/closed data through an accessible table', () => {
    render(<IncidentTrendChart buckets={buckets} />);
    const table = screen.getByRole('table', { name: /נתוני פתיחה וסגירת תקלות/ });
    const rows = table.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);

    const cells = rows[0].querySelectorAll('td');
    expect(cells[1]).toHaveTextContent('2');
    expect(cells[2]).toHaveTextContent('0');

    const lastRowCells = rows[2].querySelectorAll('td');
    expect(lastRowCells[1]).toHaveTextContent('1');
    expect(lastRowCells[2]).toHaveTextContent('3');
  });

  it('hides the visual chart from the accessibility tree so the data is announced once, not twice', () => {
    const { container } = render(<IncidentTrendChart buckets={buckets} />);
    const visualWrapper = container.querySelector('[aria-hidden="true"]');
    expect(visualWrapper).not.toBeNull();
    expect(visualWrapper?.querySelector('svg')).not.toBeNull();

    // The chart's own row/column data must not additionally surface as
    // accessible-tree text nodes outside the sr-only table (e.g. via
    // recharts' default role="application" layer) -- there is exactly one
    // accessible table, not one table plus a parallel announced chart.
    expect(screen.getAllByRole('table')).toHaveLength(1);
  });

  it('renders a zero-bucket period as an empty-but-present accessible table, not an empty state', () => {
    render(<IncidentTrendChart buckets={[]} />);
    const table = screen.getByRole('table', { name: /נתוני פתיחה וסגירת תקלות/ });
    expect(table.querySelectorAll('tbody tr')).toHaveLength(0);
  });
});

describe('IncidentTrendChart: drill-down click affordance', () => {
  it('marks the chart as clickable (pointer cursor) only when onBucketClick is provided', () => {
    const { container: withHandler } = render(<IncidentTrendChart buckets={buckets} onBucketClick={vi.fn()} />);
    expect(withHandler.querySelector('.recharts-wrapper.cursor-pointer')).not.toBeNull();

    const { container: withoutHandler } = render(<IncidentTrendChart buckets={buckets} />);
    expect(withoutHandler.querySelector('.recharts-wrapper.cursor-pointer')).toBeNull();
  });
});

describe('bucketFromChartClick', () => {
  const data = buckets.map((b) => ({ ...b, label: 'x' }));

  it('resolves a valid index to the plain AnalyticsBucket at that position', () => {
    expect(bucketFromChartClick(data, 2)).toEqual({ bucketStart: '2026-08-02', opened: 1, closed: 3 });
  });

  it('resolves a valid index given as a STRING -- recharts v3 always reports activeIndex as a numeric string at runtime (e.g. "2"), never an actual number, despite its type declaration allowing both', () => {
    expect(bucketFromChartClick(data, '2')).toEqual({ bucketStart: '2026-08-02', opened: 1, closed: 3 });
  });

  it('returns null when no index is active (click missed every bucket)', () => {
    expect(bucketFromChartClick(data, undefined)).toBeNull();
  });

  it('returns null when activeIndex is null (recharts reports null before any interaction)', () => {
    expect(bucketFromChartClick(data, null)).toBeNull();
  });

  it('returns null for an out-of-range index rather than throwing', () => {
    expect(bucketFromChartClick(data, 99)).toBeNull();
  });

  it('returns null for a non-numeric string index rather than throwing', () => {
    expect(bucketFromChartClick(data, 'not-a-number')).toBeNull();
  });
});

describe('TrendTooltipContent', () => {
  const payload = [
    { dataKey: 'opened', value: 4 },
    { dataKey: 'closed', value: 2 },
  ];

  it('renders nothing while inactive (recharts renders the tooltip host unconditionally)', () => {
    const { container } = render(<TrendTooltipContent active={false} payload={payload} label="05/08" showHint />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the bucket label and both opened/closed values when active', () => {
    render(<TrendTooltipContent active payload={payload} label="05/08" showHint={false} />);
    expect(screen.getByText('05/08')).toBeInTheDocument();
    expect(screen.getByText(/נפתחו: 4/)).toBeInTheDocument();
    expect(screen.getByText(/נסגרו: 2/)).toBeInTheDocument();
  });

  it('shows the "לחץ לצפייה בתקלות" hint only when showHint is true', () => {
    const { rerender } = render(<TrendTooltipContent active payload={payload} label="05/08" showHint={false} />);
    expect(screen.queryByText('לחץ לצפייה בתקלות')).not.toBeInTheDocument();

    rerender(<TrendTooltipContent active payload={payload} label="05/08" showHint />);
    expect(screen.getByText('לחץ לצפייה בתקלות')).toBeInTheDocument();
  });
});
