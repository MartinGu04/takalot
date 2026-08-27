// Device-local, per-user "postpone the onboarding modal" cooldown -- the
// same storage shape and safety discipline as push/pushDevicePreference.ts
// (a plain, try/catch-wrapped localStorage flag, scoped by userId, never
// throwing on private-browsing/quota/unavailable storage).
//
// This is NOT a "setup completed" flag: whether onboarding still has
// anything actionable to show is decided fresh, every time, by
// determineOnboardingStep() from THIS device's live state (installed?
// Push subscribed?) -- see useOnboardingState.ts. This module only
// answers "did the user just say אחר כך (later), recently, on this
// device", so the modal does not reopen on every single navigation or
// login while something is still actionable, without ever needing a
// separate "mark as done" write once the real state resolves itself.

const STORAGE_PREFIX = 'takalot-onboarding-dismissed-until:';

/** How long a "אחר כך" postpones the modal before it may show again. Long
 *  enough that it never feels like nagging within one sitting; short
 *  enough that a still-unconfigured device is reminded again the same
 *  day, not just once ever. */
export const ONBOARDING_DISMISS_COOLDOWN_MS = 12 * 60 * 60 * 1000;

function keyFor(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

/** Records that `userId` postponed onboarding on this device just now. */
export function dismissOnboarding(userId: string, now: () => number = Date.now): void {
  try {
    localStorage.setItem(keyFor(userId), String(now() + ONBOARDING_DISMISS_COOLDOWN_MS));
  } catch {
    // Best-effort -- see module comment.
  }
}

/** True only while `userId`'s most recent dismissal on this device is
 *  still within the cooldown window. Never throws; a missing, malformed,
 *  or expired value is simply "not dismissed". */
export function isOnboardingDismissed(userId: string, now: () => number = Date.now): boolean {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return false;
    const until = Number(raw);
    if (!Number.isFinite(until)) return false;
    return now() < until;
  } catch {
    return false;
  }
}
