import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgeDistributionChart } from './AgeDistributionChart';
import type { IncidentOpenBacklog } from '../../domain/analyticsOpenBacklog';

function makeBacklog(overrides: Partial<IncidentOpenBacklog> = {}): IncidentOpenBacklog {
  return {
    currentlyOpen: 4,
    bands: [
      { band: 'lt_1d', count: 1 },
      { band: '1_3d', count: 1 },
      { band: '3_7d', count: 1 },
      { band: '7_14d', count: 0 },
      { band: 'gt_14d', count: 1 },
    ],
    ...overrides,
  };
}

describe('AgeDistributionChart', () => {
  it('shows a good-news empty state when there is no open backlog, not a blank chart', () => {
    render(<AgeDistributionChart backlog={makeBacklog({ currentlyOpen: 0, bands: [] })} />);
    expect(screen.getByText('אין תקלות פתוחות התואמות את הסינון הנוכחי')).toBeInTheDocument();
  });

  it('exposes every band, zero-filled, via the accessible sr-only table', () => {
    render(<AgeDistributionChart backlog={makeBacklog()} />);
    const table = screen.getByText('התפלגות גיל התקלות הפתוחות הנוכחיות').closest('table') as HTMLElement;
    expect(table).toBeInTheDocument();
    for (const label of ['פחות מיום', '1–3 ימים', '3–7 ימים', '7–14 ימים', 'מעל 14 יום']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
