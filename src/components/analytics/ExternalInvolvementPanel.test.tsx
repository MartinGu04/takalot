import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExternalInvolvementPanel } from './ExternalInvolvementPanel';

describe('ExternalInvolvementPanel', () => {
  it('renders all three counts as independent, distinctly labeled compact cards', () => {
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
    expect(screen.getByText('תקלות שנסגרו עם גורם חיצוני בתקופה')).toBeInTheDocument();
    expect(screen.getByText('פתרון שיוחס לגורם חיצוני בתקופה')).toBeInTheDocument();
    expect(screen.getByText('תקלות פתוחות שתלויות כרגע בגורם חיצוני')).toBeInTheDocument();
  });

  it('renders exactly three cards, one per metric, each its own surface container', () => {
    const { container } = render(
      <ExternalInvolvementPanel
        causeExternalClosedCount={3}
        resolutionAttributionExternalCount={2}
        externallyHandledOpenCount={5}
      />,
    );
    expect(container.querySelectorAll('.surface')).toHaveLength(3);
  });

  it('marks the third (current-state) stat as not period-scoped, distinct from the other two, as one clear caption', () => {
    render(
      <ExternalInvolvementPanel
        causeExternalClosedCount={0}
        resolutionAttributionExternalCount={0}
        externallyHandledOpenCount={0}
      />,
    );
    expect(screen.getByText('כעת · לא מוגבל לתקופה שנבחרה')).toBeInTheDocument();
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
