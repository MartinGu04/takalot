import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveClock } from './LiveClock';

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveClock', () => {
  it('renders device-local time and a localized Hebrew date, then advances each second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 30, 14, 5, 9));

    render(<LiveClock />);

    expect(screen.getByTestId('live-clock-time')).toHaveTextContent('14:05:09');
    expect(screen.getByTestId('live-clock-date')).toHaveTextContent('2026');

    act(() => vi.advanceTimersByTime(1_000));

    expect(screen.getByTestId('live-clock-time')).toHaveTextContent('14:05:10');
  });

  it('keeps second-by-second changes out of live regions and clears its timer on unmount', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    const { unmount } = render(<LiveClock />);

    expect(screen.getByTestId('desktop-live-clock')).toHaveAttribute(
      'aria-label',
      'זמן מקומי במכשיר',
    );
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(document.querySelector('[aria-live]')).not.toBeInTheDocument();

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    clearTimeoutSpy.mockRestore();
  });
});
