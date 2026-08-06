import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { OfflineBanner } from './OfflineBanner';

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
}

describe('OfflineBanner', () => {
  afterEach(() => {
    setOnline(true);
  });

  it('renders nothing while the browser reports connectivity', () => {
    setOnline(true);
    const { container } = render(<OfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the exact offline copy once the browser reports no connection', () => {
    setOnline(true);
    render(<OfflineBanner />);
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(
      screen.getByText('אין חיבור לאינטרנט. הצגת מידע וביצוע פעולות אינם זמינים עד לחזרת החיבור.'),
    ).toBeInTheDocument();
  });

  it('disappears again once connectivity returns', () => {
    setOnline(false);
    render(<OfflineBanner />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('registers exactly one online/offline listener pair and cleans them up on unmount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<OfflineBanner />);

    expect(addSpy.mock.calls.filter((c) => c[0] === 'online')).toHaveLength(1);
    expect(addSpy.mock.calls.filter((c) => c[0] === 'offline')).toHaveLength(1);

    unmount();

    expect(removeSpy.mock.calls.filter((c) => c[0] === 'online')).toHaveLength(1);
    expect(removeSpy.mock.calls.filter((c) => c[0] === 'offline')).toHaveLength(1);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
