// Single source of truth for AVARIA's client-side Push subscription state
// and actions. UI components (see PushNotificationSettings.tsx) render this
// hook's output; they never recompute the state machine or call browser
// Push APIs / the repository directly.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../auth/AuthContext';
import { repo } from '../data/hooks';
import type { Session } from '../data/repository';
import { useToast } from '../components/ui';
import { usePwaUpdate } from '../pwa/usePwaUpdate';
import {
  isLikelyIOS,
  isPushApiSupported,
  isStandaloneDisplayMode,
} from './pushCapabilities';
import { clearPushWanted, isPushWanted, rememberPushWanted } from './pushDevicePreference';
import { getConfiguredVapidPublicKey, isValidVapidPublicKey, urlBase64ToUint8Array } from './vapidKey';

export type PushSubscriptionState =
  | 'unsupported'
  | 'install-required'
  | 'permission-default'
  | 'permission-denied'
  | 'not-subscribed'
  | 'subscribed'
  | 'loading'
  | 'error'
  | 'configuration-unavailable';

export interface UsePushSubscriptionResult {
  state: PushSubscriptionState;
  /** Count of the caller's OTHER Push-subscribed devices -- never includes
   *  the current device. 0 whenever state !== 'subscribed'. */
  otherDeviceCount: number;
  /** A new Service Worker is installed and waiting (see usePwaUpdate) --
   *  enable() refuses to subscribe against a possibly push-blind worker
   *  until the user updates through the existing AVARIA update flow. */
  updatePending: boolean;
  /** Must only be called from a direct user gesture (click/tap) -- never on
   *  render, mount, or login. Requests permission only when it is currently
   *  'default'; never re-prompts once denied. */
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  disconnectAll: () => Promise<void>;
}

const SAVE_FAILED_MESSAGE = 'לא ניתן היה לשמור את ההתראות בשרת. נא לנסות שוב.';
const ENABLE_FAILED_MESSAGE = 'לא ניתן היה להפעיל התראות במכשיר זה. נא לנסות שוב.';
const DISABLE_FAILED_MESSAGE = 'לא ניתן היה לכבות את ההתראות במכשיר זה. נא לנסות שוב.';
const DISCONNECT_ALL_FAILED_MESSAGE = 'לא ניתן היה לנתק את כל המכשירים. נא לנסות שוב.';
const UPDATE_REQUIRED_MESSAGE = 'יש לעדכן את המערכת לפני הפעלת התראות במכשיר זה.';
const ENABLED_MESSAGE = 'התראות הופעלו במכשיר זה';
const DISABLED_MESSAGE = 'התראות כובו במכשיר זה';
const DISCONNECTED_ALL_MESSAGE = 'כל המכשירים נותקו';

type SubscribeAndPersistResult =
  | { ok: true }
  | { ok: false; reason: 'permission-not-granted' | 'permission-denied' | 'save-failed' | 'cancelled' };

/**
 * The one place that turns a browser PushSubscription into a server-saved
 * one -- shared by enable() (explicit, user-gestured) and the silent
 * auto-restore effect below (background, on login). Both go through the
 * exact same ownership/save call (Repository.savePushSubscription, tied to
 * auth.uid()), so auto-restore can never attach a shared-browser endpoint to
 * the wrong account any differently than a manual enable() already would.
 *
 * `allowPermissionPrompt: false` (auto-restore) never calls
 * Notification.requestPermission() -- if permission somehow is not already
 * 'granted' by the time this runs, it fails closed instead of prompting.
 *
 * `isCancelled()` is checked before every side-effecting step (creating a
 * browser subscription, saving it server-side) AND once more immediately
 * after the server save succeeds. This closes the logout race: the caller
 * (whichever hook instance's mount this session belongs to) can go away --
 * e.g. an explicit logout unmounting the whole authenticated tree -- while
 * this async chain is mid-flight. Checking only BEFORE each step reduces the
 * window but cannot eliminate it, since the save itself is a single
 * un-interruptible network round trip; the check immediately after a
 * successful save is what actually guarantees a stale/cancelled operation
 * can never leave a live subscription behind -- if cancellation is detected
 * there, the just-saved subscription is immediately detached again
 * (server-side delete, then browser unsubscribe), both best-effort, so
 * logout's "no Push survives an explicit sign-out" guarantee holds
 * regardless of how the async timing landed.
 */
async function subscribeAndPersist(
  session: Session,
  vapidKey: string,
  options: { allowPermissionPrompt: boolean; isCancelled: () => boolean },
): Promise<SubscribeAndPersistResult> {
  const registration = await navigator.serviceWorker.ready;
  if (options.isCancelled()) return { ok: false, reason: 'cancelled' };
  let permission: NotificationPermission = Notification.permission;
  if (permission === 'default') {
    if (!options.allowPermissionPrompt) {
      return { ok: false, reason: 'permission-not-granted' };
    }
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') {
    return { ok: false, reason: permission === 'denied' ? 'permission-denied' : 'permission-not-granted' };
  }
  if (options.isCancelled()) return { ok: false, reason: 'cancelled' };
  let subscription = await registration.pushManager.getSubscription();
  // Tracks whether THIS call created the subscription, so a later
  // server-save failure only rolls back what this action itself did -- a
  // pre-existing subscription (e.g. a shared-browser endpoint from a
  // previous account) is never torn down just because the transfer failed;
  // it is left for the next attempt or disable/disconnect flow to resolve.
  let createdNew = false;
  if (!subscription) {
    if (options.isCancelled()) return { ok: false, reason: 'cancelled' };
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
    createdNew = true;
  }
  const keys = subscription.toJSON().keys;
  if (!keys?.p256dh || !keys.auth) {
    throw new Error('push subscription missing encryption keys');
  }
  if (options.isCancelled()) {
    // Never persist server-side for an operation that is no longer wanted
    // (e.g. the session this belongs to already logged out) -- roll back a
    // freshly-created browser subscription rather than leaving it dangling
    // with no server record at all.
    if (createdNew) {
      try {
        await subscription.unsubscribe();
      } catch {
        // Best-effort -- see the module-level rollback comments below.
      }
    }
    return { ok: false, reason: 'cancelled' };
  }
  try {
    await repo().savePushSubscription(session, subscription.endpoint, { p256dh: keys.p256dh, auth: keys.auth });
  } catch {
    if (createdNew) {
      try {
        await subscription.unsubscribe();
      } catch {
        // Best-effort rollback -- the caller must not report success either
        // way; evaluate() reflects whatever is actually true afterward.
      }
    }
    return { ok: false, reason: 'save-failed' };
  }
  if (options.isCancelled()) {
    // The save above just committed this subscription to `session`'s
    // account server-side, but by the time it resolved this operation was
    // already cancelled -- most importantly, the SAME user may have
    // explicitly logged out while the save was in flight. Detach it again
    // immediately so no Push subscription survives an explicit sign-out
    // regardless of async timing. Both steps are best-effort: the
    // server-side delete can itself fail once the session/JWT that
    // authorized it is gone (expected post-logout), but the browser
    // unsubscribe always succeeds or is harmless, and an unsubscribed
    // endpoint can never receive another push no matter what the server
    // row says.
    try {
      await repo().deletePushSubscription(session, subscription.endpoint);
    } catch {
      // Best-effort -- see comment above.
    }
    try {
      await subscription.unsubscribe();
    } catch {
      // Best-effort -- see comment above.
    }
    return { ok: false, reason: 'cancelled' };
  }
  return { ok: true };
}

/**
 * De-duplicates concurrent subscribeAndPersist() calls within one
 * usePushSubscription() instance: if the silent auto-restore effect is
 * already mid-flight when the user opens Push settings and presses enable()
 * (or vice versa), the second caller reuses the SAME in-flight
 * browser-subscribe/server-save operation instead of racing an independent
 * one -- avoiding two concurrent PushManager.subscribe() calls and two
 * concurrent savePushSubscription() writes for the same device/session.
 */
function runSubscribeAndPersist(
  inFlightRef: { current: Promise<SubscribeAndPersistResult> | null },
  session: Session,
  vapidKey: string,
  options: { allowPermissionPrompt: boolean; isCancelled: () => boolean },
): Promise<SubscribeAndPersistResult> {
  if (inFlightRef.current) return inFlightRef.current;
  const promise = subscribeAndPersist(session, vapidKey, options).finally(() => {
    if (inFlightRef.current === promise) inFlightRef.current = null;
  });
  inFlightRef.current = promise;
  return promise;
}

export function usePushSubscription(): UsePushSubscriptionResult {
  const session = useSession();
  const toast = useToast();
  const { needRefresh } = usePwaUpdate();
  const [state, setState] = useState<PushSubscriptionState>('loading');
  const [otherDeviceCount, setOtherDeviceCount] = useState(0);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
  // Shared between enable() and the auto-restore effect below -- see
  // runSubscribeAndPersist's own comment.
  const inFlightRef = useRef<Promise<SubscribeAndPersistResult> | null>(null);

  /**
   * Re-derives the current-device state from scratch: browser support,
   * permission, configured VAPID key, the browser's own PushSubscription
   * (navigator.serviceWorker.ready -> pushManager.getSubscription()), and --
   * only when a subscription exists -- server-side ownership confirmation
   * via is_my_push_subscription. This is the ONLY place that combines these
   * signals into one of the documented states; enable/disable/disconnectAll
   * all re-run this afterward instead of guessing the resulting state.
   */
  const evaluate = useCallback(async () => {
    if (!isPushApiSupported()) {
      setState(isLikelyIOS() && !isStandaloneDisplayMode() ? 'install-required' : 'unsupported');
      setOtherDeviceCount(0);
      return;
    }
    if (Notification.permission === 'denied') {
      setState('permission-denied');
      setOtherDeviceCount(0);
      return;
    }
    const vapidKey = getConfiguredVapidPublicKey();
    if (!isValidVapidPublicKey(vapidKey)) {
      setState('configuration-unavailable');
      setOtherDeviceCount(0);
      return;
    }
    if (Notification.permission === 'default') {
      setState('permission-default');
      setOtherDeviceCount(0);
      return;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        if (!mountedRef.current) return;
        setState('not-subscribed');
        setOtherDeviceCount(0);
        return;
      }
      // Shared-browser guard: a real browser PushSubscription alone does not
      // prove it belongs to the CURRENTLY signed-in AVARIA user.
      const mine = await repo().isMyPushSubscription(session, subscription.endpoint);
      if (!mountedRef.current) return;
      if (!mine) {
        setState('not-subscribed');
        setOtherDeviceCount(0);
        return;
      }
      // Backfill for users who already had a working, server-confirmed
      // subscription on this device from BEFORE this preference existed
      // (pre-release users) -- a positively-owned subscription right now is
      // exactly the same evidence enable() itself would have recorded, so
      // treat it identically. This can never fire from permission alone, an
      // unowned/foreign endpoint, or a subscription whose server ownership
      // an explicit disable/disconnect already removed (isMyPushSubscription
      // would be false in all of those cases and this line is unreached) --
      // so it can never resurrect a preference an explicit action just
      // cleared. Idempotent: a no-op once the preference is already set.
      rememberPushWanted(session.userId);
      const count = await repo().countPushSubscriptions(session);
      if (!mountedRef.current) return;
      setState('subscribed');
      setOtherDeviceCount(Math.max(0, count - 1));
    } catch {
      if (!mountedRef.current) return;
      setState('error');
      setOtherDeviceCount(0);
    }
  }, [session]);

  useEffect(() => {
    void evaluate();
  }, [evaluate]);

  const enable = useCallback(async () => {
    // Never re-prompt once denied -- browser permission semantics are final
    // until the user changes it themselves through browser/device settings.
    if (Notification.permission === 'denied') {
      setState('permission-denied');
      return;
    }
    if (needRefresh) {
      // Smallest reliable Service Worker freshness guard: needRefresh means
      // a NEW worker is already installed and waiting (see usePwaUpdate) --
      // subscribing now could bind against a worker that predates Phase 3's
      // push/notificationclick handlers. Guide the user through the
      // existing update flow (UpdatePrompt) instead of subscribing blind.
      toast(UPDATE_REQUIRED_MESSAGE, 'error');
      return;
    }
    const vapidKey = getConfiguredVapidPublicKey();
    if (!vapidKey || !isValidVapidPublicKey(vapidKey)) {
      setState('configuration-unavailable');
      return;
    }
    setState('loading');
    try {
      const outcome = await runSubscribeAndPersist(inFlightRef, session, vapidKey, {
        allowPermissionPrompt: true,
        isCancelled: () => !mountedRef.current,
      });
      if (!mountedRef.current) return;
      if (!outcome.ok) {
        if (outcome.reason === 'permission-denied') {
          setState('permission-denied');
          return;
        }
        if (outcome.reason === 'permission-not-granted') {
          setState('permission-default');
          return;
        }
        setState('error');
        toast(SAVE_FAILED_MESSAGE, 'error');
        return;
      }
      // Only remember the device intent AFTER the server actually accepted
      // the subscription -- never optimistically before that (see
      // pushDevicePreference.ts).
      rememberPushWanted(session.userId);
      await evaluate();
      toast(ENABLED_MESSAGE, 'success');
    } catch {
      if (!mountedRef.current) return;
      setState('error');
      toast(ENABLE_FAILED_MESSAGE, 'error');
    }
  }, [needRefresh, session, evaluate, toast]);

  const disable = useCallback(async () => {
    setState('loading');
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        // Server-side removal FIRST, browser unsubscribe second: the final
        // state must never claim the device is disabled while a known live
        // server-side subscription still belongs to this user. If the
        // server delete fails, the browser subscription is deliberately
        // left intact (still functional, retry stays available) and the UI
        // reports an error rather than a false "disabled".
        await repo().deletePushSubscription(session, subscription.endpoint);
        try {
          await subscription.unsubscribe();
        } catch {
          // Best-effort: the server no longer owns/sends to this endpoint
          // either way, so a local unsubscribe failure here is harmless --
          // evaluate() will show 'not-subscribed' next time regardless.
        }
      }
      // A real preference change -- unlike logout, which only detaches the
      // subscription (see pushLogoutCleanup.ts), this must stop AVARIA from
      // silently re-subscribing this user on this device on a future login.
      clearPushWanted(session.userId);
      await evaluate();
      toast(DISABLED_MESSAGE, 'success');
    } catch {
      if (!mountedRef.current) return;
      setState('error');
      toast(DISABLE_FAILED_MESSAGE, 'error');
    }
  }, [session, evaluate, toast]);

  const disconnectAll = useCallback(async () => {
    setState('loading');
    try {
      await repo().deleteAllPushSubscriptions(session);
      // Same reasoning as disable() above: an explicit disconnect must also
      // stop this device from silently re-subscribing this user later. Only
      // ever touches THIS device's local preference -- it cannot reach the
      // preference remembered on another physical device.
      clearPushWanted(session.userId);
      // Best-effort local cleanup only -- this can never reach a
      // PushSubscription living in another device's browser; deleting the
      // server rows is what actually stops AVARIA from sending to them.
      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) await subscription.unsubscribe();
      } catch {
        // Best-effort -- the server-side disconnect above already succeeded.
      }
      await evaluate();
      toast(DISCONNECTED_ALL_MESSAGE, 'success');
    } catch {
      if (!mountedRef.current) return;
      setState('error');
      toast(DISCONNECT_ALL_FAILED_MESSAGE, 'error');
    }
  }, [session, evaluate, toast]);

  // Silent, best-effort auto-restore: once evaluate() lands on
  // 'not-subscribed' for a user who previously enabled Push on THIS device
  // (see pushDevicePreference.ts), and every other gate below is already
  // satisfied, quietly recreate the subscription through the exact same
  // ownership/save path enable() uses -- no permission prompt, no toast, and
  // a failure here never surfaces as an 'error' state: it is simply left
  // 'not-subscribed' for the next explicit attempt or the next login. This
  // is what makes logout -> login for the SAME user restore Push without any
  // button press, while a different user (or a user who never opted in on
  // this device) never gets auto-subscribed.
  useEffect(() => {
    if (state !== 'not-subscribed') return;
    if (needRefresh) return;
    if (Notification.permission !== 'granted') return;
    if (!isPushWanted(session.userId)) return;
    const vapidKey = getConfiguredVapidPublicKey();
    if (!vapidKey || !isValidVapidPublicKey(vapidKey)) return;

    let cancelled = false;
    void (async () => {
      try {
        // Deliberately NOT `cancelled` here -- only real unmount (see
        // mountedRef, e.g. an explicit logout tearing down the whole
        // authenticated tree) may cancel the underlying side effects this
        // shares with enable() via runSubscribeAndPersist. `cancelled`
        // itself flips on any dependency change, including `state` moving
        // to 'loading' because the user just pressed enable() -- and since
        // that same enable() call may be the one AWAITING this exact
        // in-flight operation (see runSubscribeAndPersist's de-dup
        // comment), gating the shared side effects on `cancelled` would
        // make a legitimate, user-initiated enable() roll back its own
        // save. mountedRef, by contrast, only goes false on a real
        // teardown, which is exactly the security-relevant boundary here.
        const outcome = await runSubscribeAndPersist(inFlightRef, session, vapidKey, {
          allowPermissionPrompt: false,
          isCancelled: () => !mountedRef.current,
        });
        if (cancelled || !mountedRef.current) return;
        if (outcome.ok) {
          await evaluate();
        }
      } catch {
        // Best-effort -- never break login/auth on a background restore
        // failure; the UI stays exactly as evaluate() last resolved it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, session, needRefresh, evaluate]);

  return { state, otherDeviceCount, updatePending: needRefresh, enable, disable, disconnectAll };
}
