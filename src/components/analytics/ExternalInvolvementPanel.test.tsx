import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExternalInvolvementPanel } from './ExternalInvolvementPanel';

describe('ExternalInvolvementPanel', () => {
  it('renders all three counts as independent, distinctly labeled stats', () => {
    render(
      <ExternalInvolvementPanel
        causeExternalClosedCount={3}
        resolutionAttributionExternalCount={2}
        externallyHandledOpenCount={5}
      />,
    );
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('תקלות שנגרמו מגורם חיצוני (בתקופה)')).toBeInTheDocument();
    expect(screen.getByText('פתרון שיוחס לגורם חיצוני (בתקופה)')).toBeInTheDocument();
    expect(screen.getByText('תקלות פתוחות התלויות בגורם חיצוני')).toBeInTheDocument();
  });

  it('marks the third (current-state) stat as not period-scoped, distinct from the other two', () => {
    render(
      <ExternalInvolvementPanel
        causeExternalClosedCount={0}
        resolutionAttributionExternalCount={0}
        externallyHandledOpenCount={0}
      />,
    );
    expect(screen.getByText('כרגע')).toBeInTheDocument();
    expect(screen.getByText('לא מוגבל לתקופה שנבחרה')).toBeInTheDocument();
  });

  it('shows a real 0, not a hidden/greyed state, when there is no external involvement at all', () => {
    render(
      <ExternalInvolvementPanel
        causeExternalClosedCount={0}
        resolutionAttributionExternalCount={0}
        externallyHandledOpenCount={0}
      />,
    );
    expect(screen.getAllByText('0')).toHaveLength(3);
  });
});
