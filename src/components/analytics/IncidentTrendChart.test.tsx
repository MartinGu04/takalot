// Focused accessibility coverage: the visual Recharts SVG must be hidden
// from assistive technology, and the same per-bucket data must be
// available through an accessible (sr-only) table instead -- not both, and
// not neither.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IncidentTrendChart } from './IncidentTrendChart';
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
