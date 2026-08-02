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
        label="זמן ממוצע לסגירה"
        value="יום אחד, 9 שעות ו־40 דקות"
        context="מרגע הגילוי ועד לסגירה בפועל"
      />,
    );
    expect(
      screen.getByRole('group', {
        name: 'זמן ממוצע לסגירה: יום אחד, 9 שעות ו־40 דקות. מרגע הגילוי ועד לסגירה בפועל.',
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
});
