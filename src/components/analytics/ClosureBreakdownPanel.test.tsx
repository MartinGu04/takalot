import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ClosureBreakdownPanel } from './ClosureBreakdownPanel';
import type { IncidentClosureInsights } from '../../domain/analyticsClosureInsights';

function makeInsights(overrides: Partial<IncidentClosureInsights> = {}): IncidentClosureInsights {
  return {
    structuredClosuresInPeriod: 3,
    totalClosureEventsInPeriod: 4,
    confirmedCauseCounts: [
      { value: 'equipment', count: 2 },
      { value: 'software', count: 1 },
    ],
    treatmentOutcomeCounts: [
      { value: 'permanent_resolution', count: 2 },
      { value: 'temporary_workaround', count: 1 },
    ],
    causeExternalClosedCount: 0,
    resolutionAttributionExternalCount: 0,
    ...overrides,
  };
}

describe('ClosureBreakdownPanel', () => {
  it('renders both breakdown lists with Hebrew enum labels, counts, and percentages', () => {
    render(<ClosureBreakdownPanel insights={makeInsights()} />);
    expect(screen.getByText('גורם שאומת')).toBeInTheDocument();
    expect(screen.getByText('תוצאת הטיפול')).toBeInTheDocument();
    expect(screen.getByText('ציוד או חומרה')).toBeInTheDocument();
    expect(screen.getByText('פתרון קבוע')).toBeInTheDocument();
    // 2 of 3 structured closures -> 67%, for both the top cause row and the
    // top outcome row (coincidentally the same fraction in this fixture).
    expect(screen.getAllByText('67%')).toHaveLength(2);
  });

  it('shows the coverage footer stating X out of Y closure actions, never a bare count', () => {
    render(<ClosureBreakdownPanel insights={makeInsights()} />);
    expect(screen.getByText(/מבוסס על 3 מתוך 4 תקלות עם פעולת סגירה בתקופה זו/)).toBeInTheDocument();
  });

  it('omits the row-level-vs-broader-denominator clarification when no confirmed-cause/treatment-outcome filter is active', () => {
    render(<ClosureBreakdownPanel insights={makeInsights()} />);
    expect(screen.queryByText(/המספר הראשון תואם את סינון/)).not.toBeInTheDocument();
  });

  it('adds a clarifying sentence when a confirmed-cause/treatment-outcome filter is active, so X (row-filtered) and Y (page-wide, unfiltered) are never read as the same population', () => {
    render(<ClosureBreakdownPanel insights={makeInsights()} causeOrOutcomeFilterActive />);
    expect(screen.getByText(/מבוסס על 3 מתוך 4 תקלות עם פעולת סגירה בתקופה זו/)).toBeInTheDocument();
    expect(screen.getByText(/המספר הראשון תואם את סינון הגורם\/התוצאה שנבחר/)).toBeInTheDocument();
    expect(screen.getByText(/המספר השני כולל את כלל פעולות הסגירה בתקופה/)).toBeInTheDocument();
  });

  it('shows a distinct empty state when there were no closure actions at all this period', () => {
    render(
      <ClosureBreakdownPanel
        insights={makeInsights({ totalClosureEventsInPeriod: 0, structuredClosuresInPeriod: 0, confirmedCauseCounts: [], treatmentOutcomeCounts: [] })}
      />,
    );
    expect(screen.getByText('אין תקלות עם פעולת סגירה בתקופה שנבחרה')).toBeInTheDocument();
  });

  it('shows a distinct empty state when closures happened but none carried structured classification (not a misleading 0%)', () => {
    render(
      <ClosureBreakdownPanel
        insights={makeInsights({ totalClosureEventsInPeriod: 2, structuredClosuresInPeriod: 0, confirmedCauseCounts: [], treatmentOutcomeCounts: [] })}
      />,
    );
    expect(screen.getByText('אין תקלות עם סיווג סגירה מובנה בתקופה זו')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });
});
