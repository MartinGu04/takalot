// Restrained, app-wide "no connection" notice. AVARIA is online-only: this
// banner only ever reflects the browser's live connectivity signal (see
// useOnlineStatus) -- it never shows stale/cached incident data as current,
// queues writes, or claims anything will sync later.
import { useOnlineStatus } from './useOnlineStatus';

export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-red-700 px-4 py-1.5 text-center text-xs font-medium text-white dark:bg-red-800"
    >
      אין חיבור לאינטרנט. הצגת מידע וביצוע פעולות אינם זמינים עד לחזרת החיבור.
    </div>
  );
}
