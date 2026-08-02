import { describe, expect, it } from 'vitest';
import { formatDuration, formatDurationMinutes } from './time';

describe('formatDurationMinutes (compact, analytics-only)', () => {
  it('renders null as a dash, not an invented "0 דקות"', () => {
    expect(formatDurationMinutes(null)).toBe('—');
  });

  it('renders 0 minutes explicitly', () => {
    expect(formatDurationMinutes(0)).toBe('0 דקות');
  });

  it('renders a sub-minute value as 0 minutes (rounded)', () => {
    expect(formatDurationMinutes(0.4)).toBe('0 דקות');
  });

  it('renders exactly one minute in the singular', () => {
    expect(formatDurationMinutes(1)).toBe('1 דקה');
  });

  it('renders under an hour as minutes alone', () => {
    expect(formatDurationMinutes(45)).toBe('45 דקות');
  });

  it('renders exactly one hour with no trailing ", 0 דקות"', () => {
    expect(formatDurationMinutes(60)).toBe('1 שעה');
  });

  it('renders hours plus minutes, capped at two components', () => {
    expect(formatDurationMinutes(90)).toBe('1 שעה, 30 דקות');
  });

  it('renders exactly one day with no trailing ", 0 שעות"', () => {
    expect(formatDurationMinutes(1440)).toBe('1 יום');
  });

  it('drops minutes once days are shown -- the task\'s own worked example (2380 min = 1d 15h 40m)', () => {
    expect(formatDurationMinutes(1 * 1440 + 15 * 60 + 40)).toBe('1 יום, 15 שעות');
  });

  it('renders a multi-day plural value as days + hours only, never three components', () => {
    // 2 days, 3 hours, 20 minutes -- the 20 minutes must not appear.
    expect(formatDurationMinutes(2 * 1440 + 3 * 60 + 20)).toBe('2 ימים, 3 שעות');
  });

  it('is deliberately more compact than formatDuration for the same interval (different contexts, different verbosity)', () => {
    const minutes = 3 * 60 + 20;
    const compact = formatDurationMinutes(minutes);
    const full = formatDuration('2026-01-01T00:00:00.000Z', '2026-01-01T03:20:00.000Z');
    expect(compact).toBe('3 שעות, 20 דקות');
    expect(full).toBe('3 שעות ו־20 דקות');
    expect(compact).not.toBe(full);
  });
});
