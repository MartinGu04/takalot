// Bounded, best-effort Push detachment for the CURRENT device, run from the
// explicit logout path ONLY (see AuthContext.tsx's two logout()
// implementations) -- never from passive session expiry (markSessionExpired),
// token-refresh failure, or page close. Centralized here so all four logout
// UI call sites (Sidebar, Layout's mobile menu, both AuthScreens buttons)
// get identical behavior through the one `logout` function each provider
// already exposes, with no duplication.
import type { Repository, Session } from '../data/repository';

const DEFAULT_TIMEOUT_MS = 2000;

export interface LogoutPushSubscriptionLike {
  endpoint: string;
  unsubscribe: () => Promise<boolean>;
}

export interface LogoutPushRegistrationLike {
  pushManager: {
    getSubscription: () => Promise<LogoutPushSubscriptionLike | null>;
  };
}

export interface DetachCurrentDevicePushOptions {
  /** Resolves to the current registration, or null/undefined when none
   *  exists. Deliberately NOT navigator.serviceWorker.ready, which can hang
   *  indefinitely waiting for a worker to activate -- logout must stay
   *  bounded even with no controlling worker at all. */
  getRegistration: () => Promise<LogoutPushRegistrationLike | null | undefined>;
  deleteSubscription: (endpoint: string) => Promise<void>;
  timeoutMs?: number;
}

/**
 * Attempts, within timeoutMs, to: read the browser's current
 * PushSubscription (if any), detach it server-side via
 * delete_my_push_subscription while the JWT is still valid, then unsubscribe
 * it locally. Never throws and never blocks past the timeout -- a hung
 * Service Worker call or an offline/slow server must never trap the user
 * inside their authenticated session.
 *
 * Ordering: server-side delete first, THEN the local browser unsubscribe.
 * The server step is the one that actually stops future Push sends, so it
 * runs while there is still a chance the request completes; if it fails,
 * the browser subscription is left as-is rather than silently going out of
 * sync with a still-live server row. Both steps are independently
 * best-effort (each wrapped in its own try/catch) -- a browser unsubscribe
 * failure after a successful server delete is harmless, since the server no
 * longer owns/sends to that endpoint either way.
 */
export async function detachCurrentDevicePush(options: DetachCurrentDevicePushOptions): Promise<void> {
  const attempt = async () => {
    const registration = await options.getRegistration();
    if (!registration) return;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    try {
      await options.deleteSubscription(subscription.endpoint);
    } catch {
      // Best-effort: logout must proceed regardless of server-side outcome.
    }
    try {
      await subscription.unsubscribe();
    } catch {
      // Best-effort -- see the ordering note above.
    }
  };

  await Promise.race([
    attempt().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  ]);
}

/** Real-browser wiring for detachCurrentDevicePush, used by AuthContext's
 *  explicit logout paths only. */
export function runLogoutPushCleanup(repo: Repository, session: Session): Promise<void> {
  return detachCurrentDevicePush({
    getRegistration: async () => {
      if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
      return navigator.serviceWorker.getRegistration();
    },
    deleteSubscription: (endpoint) => repo.deletePushSubscription(session, endpoint),
  });
}
