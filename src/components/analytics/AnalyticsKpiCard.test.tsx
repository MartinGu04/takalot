// Focused accessibility coverage: assistive tech must announce label ->
// value -> context (natural reading order), exactly once -- not the raw
// DOM order (value, then label, then context), and not a duplicate read
// of the same text via both the group's name and its visible children.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnalyticsKpiCard } from './AnalyticsKpiCard';
import { IconPulse } from '../icons';

describe('AnalyticsKpiCard accessibility', () => {
  it('exposes an accessible name in label -> value -> context order for a numeric KPI', () => {
    render(
      <AnalyticsKpiCard icon={IconPulse} label="פתוחות עכשיו" value={6} context="כל התקלות הפעילות כרגע" />,
    );
    expect(
      screen.getByRole('group', { name: 'פתוחות עכשיו: 6. כל התקלות הפעילות כרגע.' }),
    ).toBeInTheDocument();
  });

  it('exposes an accessible name in label -> value -> context order for a duration-string KPI', () => {
    render(
      <AnalyticsKpiCard
        icon={IconPulse}
        label="זמן סגירה ממוצע"
        value="1 יום, 15 שעות"
        context="מגילוי ועד סגירה בפועל"
      />,
    );
    expect(
      screen.getByRole('group', {
        name: 'זמן סגירה ממוצע: 1 יום, 15 שעות. מגילוי ועד סגירה בפועל.',
      }),
    ).toBeInTheDocument();
  });

  it('does not also expose the value/label/context as separately reachable accessible text (no duplicate announcement)', () => {
    render(
      <AnalyticsKpiCard icon={IconPulse} label="פתוחות עכשיו" value={6} context="כל התקלות הפעילות כרגע" />,
    );
    const group = screen.getByRole('group', { name: 'פתוחות עכשיו: 6. כל התקלות הפעילות כרגע.' });
    // The visible content is hidden from the accessibility tree -- present
    // in the DOM (still visually rendered), but not separately announced.
    expect(group.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('renders a string (duration) value smaller than a numeric value, so a longer value never dominates the card the same way a short count does', () => {
    const { container: numeric } = render(
      <AnalyticsKpiCard icon={IconPulse} label="פתוחות עכשיו" value={6} context="כל התקלות הפעילות כרגע" />,
    );
    const { container: duration } = render(
      <AnalyticsKpiCard icon={IconPulse} label="זמן סגירה ממוצע" value="1 יום, 15 שעות" context="מגילוי ועד סגירה בפועל" />,
    );
    const numericValueEl = numeric.querySelector('[aria-hidden="true"] > div:last-child');
    const durationValueEl = duration.querySelector('[aria-hidden="true"] > div:last-child');
    expect(numericValueEl?.className).toContain('text-3xl');
    expect(durationValueEl?.className).not.toContain('text-3xl');
  });

  it('renders no ⓘ info trigger when infoTooltip is not passed', () => {
    render(<AnalyticsKpiCard icon={IconPulse} label="פתוחות עכשיו" value={6} context="כל התקלות הפעילות כרגע" />);
    expect(screen.queryByRole('button', { name: 'מידע נוסף' })).not.toBeInTheDocument();
  });

  it('renders an independently reachable ⓘ info trigger when infoTooltip is passed, without duplicating its text into the group label', () => {
    render(
      <AnalyticsKpiCard
        icon={IconPulse}
        label="זמן טיפול חציוני"
        value="1 יום"
        context="מגילוי ועד סגירה בפועל"
        infoTooltip="הסבר על החציון."
      />,
    );
    const button = screen.getByRole('button', { name: 'מידע נוסף' });
    expect(button).toBeInTheDocument();
    // Not swallowed by the card's combined aria-label.
    expect(
      screen.getByRole('group', { name: 'זמן טיפול חציוני: 1 יום. מגילוי ועד סגירה בפועל.' }),
    ).toBeInTheDocument();
  });
});
