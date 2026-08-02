import { describe, expect, it } from 'vitest';
import { formatDuration, formatDurationMinutes } from './time';

describe('formatDurationMinutes', () => {
  it('renders null as a dash, not an invented "0 דקות"', () => {
    expect(formatDurationMinutes(null)).toBe('—');
  });

  it('renders 0 minutes explicitly', () => {
    expect(formatDurationMinutes(0)).toBe('0 דקות');
  });

  it('renders a sub-minute value as 0 minutes (rounded)', () => {
    expect(formatDurationMinutes(0.4)).toBe('0 דקות');
  });

  it('renders a multi-day value with correct Hebrew pluralization', () => {
    // 2 days, 3 hours, 20 minutes.
    expect(formatDurationMinutes(2 * 1440 + 3 * 60 + 20)).toBe('2 ימים, 3 שעות ו־20 דקות');
  });

  it('renders exactly one day as the singular form', () => {
    expect(formatDurationMinutes(1440)).toBe('יום אחד');
  });

  it('shares its breakdown/pluralization with formatDuration for an equivalent interval', () => {
    const minutes = 3 * 60 + 20;
    expect(formatDurationMinutes(minutes)).toBe(
      formatDuration('2026-01-01T00:00:00.000Z', '2026-01-01T03:20:00.000Z'),
    );
  });
});
