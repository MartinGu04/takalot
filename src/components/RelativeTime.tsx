// Live Hebrew relative time ("לפני 18 דקות") that stays correct while the
// page remains open. Minute-granularity text only needs a coarse re-render
// cadence -- a 30s interval, not a per-second ticker like LiveClock.
import { useEffect, useState } from 'react';
import { formatDateTime, formatRelative } from '../lib/time';

export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className}>
      {formatRelative(iso, now)}
    </time>
  );
}
