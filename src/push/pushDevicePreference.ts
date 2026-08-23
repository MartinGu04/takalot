// Device-local, per-user memory of "this AVARIA user explicitly wants Push
// enabled on this device". This is NOT the operational notification
// preference matrix (see OperationalNotificationPreferences), which is a
// server-side, per-account setting -- this is a plain boolean flag, scoped by
// userId and stored only in this browser, used exclusively to decide whether
// usePushSubscription may silently recreate a Push subscription after a
// fresh login for the SAME user on a device they previously enabled it on.
//
// No Push encryption material, endpoint, or any other secret ever lives
// here -- the real subscription state is server-side, tied to auth.uid()
// (see Repository.savePushSubscription). This module stores nothing but a
// per-user intent flag.
//
// localStorage access can throw (private browsing, disabled storage, quota,
// or simply being unavailable) -- every operation here is a safe no-op on
// failure rather than crashing the caller.

const STORAGE_PREFIX = 'takalot-push-wanted:';

function keyFor(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

/** Records that `userId` explicitly enabled Push on this device. Call only
 *  AFTER the enable operation has actually succeeded server-side -- never
 *  optimistically before that. */
export function rememberPushWanted(userId: string): void {
  try {
    localStorage.setItem(keyFor(userId), 'true');
  } catch {
    // Best-effort -- see module comment.
  }
}

/** Forgets `userId`'s Push intent on this device -- used by an explicit
 *  disable or "disconnect all devices", never by logout (see
 *  pushLogoutCleanup.ts: detaching the active subscription on logout is a
 *  security measure, not a preference change). */
export function clearPushWanted(userId: string): void {
  try {
    localStorage.removeItem(keyFor(userId));
  } catch {
    // Best-effort -- see module comment.
  }
}

/** True only when THIS userId previously enabled Push on this device and
 *  has not since explicitly disabled it. Never true for a different user,
 *  even on the same shared device/browser. */
export function isPushWanted(userId: string): boolean {
  try {
    return localStorage.getItem(keyFor(userId)) === 'true';
  } catch {
    return false;
  }
}
