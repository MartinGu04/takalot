// Push-notification device controls, shown alongside OperationalNotificationsSwitch
// inside the "הגדרות התראות" dialog (see NotificationsMenu) -- unlike that
// switch, this is not role-gated: Push is a per-device opt-in available to
// every signed-in user, not an admin-only preference. Renders the full
// usePushSubscription state machine; never recomputes it or calls a browser
// Push API / repository method directly. No technical terms (PushManager,
// VAPID, Service Worker, endpoint) ever reach this copy -- see the hook for
// where those concepts actually live.
import type { UsePushSubscriptionResult } from '../push/usePushSubscription';
import { getConfiguredVapidPublicKey, isValidVapidPublicKey } from '../push/vapidKey';
import { Button } from './ui';

const TITLE = 'התראות במכשיר';
const ENABLE_LABEL = 'הפעל התראות במכשיר זה';
const DISABLE_LABEL = 'כבה התראות במכשיר זה';
const DISCONNECT_ALL_LABEL = 'נתק את כל המכשירים';
const ENABLED_TITLE = 'התראות פעילות במכשיר זה';
const DENIED_TITLE = 'התראות חסומות בדפדפן';
const ERROR_TEXT = 'אירעה שגיאה. נא לנסות שוב.';

function InfoRow({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <p className="text-sm font-medium text-text-primary">{title}</p>
      <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
    </div>
  );
}

/**
 * Rollout gate for the Phase 4 -> Phase 5 window: the entire Push section is
 * hidden from normal users until a valid VITE_VAPID_PUBLIC_KEY is configured
 * (the real hosted keypair is Phase 5's job) -- reuses isValidVapidPublicKey,
 * the exact same check usePushSubscription itself uses, so there is only one
 * definition of "a usable key" anywhere in the codebase. This does not
 * change usePushSubscription's own 'configuration-unavailable' state, which
 * stays in place as a defensive fail-safe inside PushSubscriptionControls
 * below for a key that is technically configured but somehow unusable at
 * runtime -- this gate only addresses the expected, known-absent case for
 * the current rollout window, before that inner state machine ever mounts.
 */
/**
 * `push` is a single usePushSubscription() instance owned by the caller
 * (NotificationsMenu) rather than called from here directly -- that hook
 * must stay mounted for as long as the user is signed in (not just while
 * this dialog happens to be open) so its silent login-time auto-restore
 * effect can actually run. See usePushSubscription's own module comment.
 */
export function PushSubscriptionSettings({ push }: { push: UsePushSubscriptionResult }) {
  if (!isValidVapidPublicKey(getConfiguredVapidPublicKey())) return null;
  return <PushSubscriptionControls push={push} />;
}

function PushSubscriptionControls({ push }: { push: UsePushSubscriptionResult }) {
  const { state, otherDeviceCount, updatePending, enable, disable, disconnectAll } = push;

  if (state === 'unsupported') {
    return <InfoRow title={TITLE} subtitle="התראות דחיפה אינן נתמכות בדפדפן זה." />;
  }
  if (state === 'install-required') {
    return <InfoRow title={TITLE} subtitle="כדי להפעיל התראות יש להוסיף את AVARIA למסך הבית ולפתוח אותה משם." />;
  }
  if (state === 'configuration-unavailable') {
    return <InfoRow title={TITLE} subtitle="הפעלת התראות אינה זמינה כרגע. ניתן לנסות שוב מאוחר יותר." />;
  }
  if (state === 'permission-denied') {
    return <InfoRow title={DENIED_TITLE} subtitle="כדי להפעיל התראות יש לשנות את ההרשאה בהגדרות הדפדפן או המכשיר." />;
  }

  const isLoading = state === 'loading';
  const isSubscribed = state === 'subscribed';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">{isSubscribed ? ENABLED_TITLE : TITLE}</p>
          {isSubscribed && otherDeviceCount > 0 && (
            <p className="mt-0.5 text-xs text-muted">מחוברים עוד {otherDeviceCount} מכשירים</p>
          )}
          {!isSubscribed && !isLoading && updatePending && (
            <p className="mt-0.5 text-xs text-muted">יש לעדכן את המערכת לפני ההפעלה</p>
          )}
          {state === 'error' && <p className="mt-0.5 text-xs text-red-700 dark:text-red-400">{ERROR_TEXT}</p>}
        </div>
        <Button
          variant={isSubscribed ? 'secondary' : 'primary'}
          disabled={isLoading}
          onClick={() => void (isSubscribed ? disable() : enable())}
        >
          {isLoading ? 'טוען…' : isSubscribed ? DISABLE_LABEL : ENABLE_LABEL}
        </Button>
      </div>
      {isSubscribed && (
        <button
          type="button"
          disabled={isLoading}
          className="self-start text-xs text-text-secondary hover:underline disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => void disconnectAll()}
        >
          {DISCONNECT_ALL_LABEL}
        </button>
      )}
    </div>
  );
}
