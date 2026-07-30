import { useEffect, useState } from 'react';

const timeFormatter = new Intl.DateTimeFormat('he-IL', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const dateFormatter = new Intl.DateTimeFormat('he-IL', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** Device-local time for the authenticated desktop header. */
export function LiveClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timerId: number;

    const scheduleNextTick = () => {
      const delay = 1_000 - (Date.now() % 1_000);
      timerId = window.setTimeout(() => {
        setNow(new Date());
        scheduleNextTick();
      }, delay);
    };

    scheduleNextTick();
    return () => window.clearTimeout(timerId);
  }, []);

  return (
    <div
      className="text-center leading-none"
      aria-label="זמן מקומי במכשיר"
      data-testid="desktop-live-clock"
    >
      <time
        dateTime={now.toISOString()}
        className="block font-mono text-lg font-bold tracking-[0.08em] text-text-primary tabular-nums"
        aria-hidden="true"
        data-testid="live-clock-time"
      >
        {timeFormatter.format(now)}
      </time>
      <span
        className="mt-1.5 block text-xs font-medium text-text-muted"
        aria-hidden="true"
        data-testid="live-clock-date"
      >
        {dateFormatter.format(now)}
      </span>
    </div>
  );
}
