// Per-event operational notification preferences ("עדכונים תפעוליים",
// AVARIA v1.6.0) -- replaces OperationalNotificationsSwitch's single
// coarse system_admin-only toggle with five independent rows (one per
// OperationalNotificationEventType), each exposing two switches: whether
// the event appears in the bell (bell/in-app) and whether it also sends a
// Push notification. Rendered only for an active operational-role user
// (system_admin/professional_manager/shift_supervisor -- exactly
// hasCapability('manage_operational_notification_preferences')). Lives
// inside the "הגדרות התראות" dialog opened from the notification-center
// gear (see NotificationsMenu), alongside PushSubscriptionSettings -- not
// in the account/user-menu areas, so there is exactly one access point.
import { useAuth } from '../auth/AuthContext';
import { useOperationalNotificationPreferences, useSetOperationalNotificationPreference } from '../data/hooks';
import { hasCapability } from '../domain/permissions';
import { operationalNotificationEventLabels, OPERATIONAL_NOTIFICATION_EVENT_ORDER } from '../domain/labels';
import type { OperationalNotificationEventType, OperationalNotificationPreference } from '../domain/types';
import { Spinner, Switch } from './ui';

const TITLE = 'עדכונים תפעוליים';
const HELPER_TEXT = 'בחר אילו עדכונים יופיעו בפעמון ואילו יישלחו גם למכשירים שלך.';
const ACTION_REQUIRED_NOTE = 'התראות שדורשות פעולה ממך (כגון תקלה שהוקצתה אליך) תמיד מוצגות ואינן חלק מהעדפות אלו.';
const COLUMN_BELL = 'בפעמון';
const COLUMN_PUSH = 'במכשיר';

export function OperationalNotificationPreferences() {
  const { user } = useAuth();
  if (!user || !hasCapability(user.role, 'manage_operational_notification_preferences')) return null;
  return <OperationalNotificationPreferencesContent />;
}

function OperationalNotificationPreferencesContent() {
  const { data: preferences, isLoading } = useOperationalNotificationPreferences();
  const mutation = useSetOperationalNotificationPreference();

  const byType = new Map<OperationalNotificationEventType, OperationalNotificationPreference>(
    (preferences ?? []).map((p) => [p.eventType, p]),
  );

  function toggleInApp(pref: OperationalNotificationPreference) {
    const nextInAppEnabled = !pref.inAppEnabled;
    mutation.mutate({
      eventType: pref.eventType,
      inAppEnabled: nextInAppEnabled,
      // Turning the event off also turns its Push off (server enforces
      // this invariant regardless -- "push requires in-app" -- kept
      // explicit here so the optimistic-feeling UI state matches exactly
      // what the server will return). Turning it back on never
      // auto-restores a previously-on Push preference; the user re-enables
      // it explicitly if they want it.
      pushEnabled: nextInAppEnabled ? pref.pushEnabled : false,
    });
  }

  function togglePush(pref: OperationalNotificationPreference) {
    if (!pref.inAppEnabled) return; // structurally unreachable (switch is disabled), defense in depth
    mutation.mutate({ eventType: pref.eventType, inAppEnabled: pref.inAppEnabled, pushEnabled: !pref.pushEnabled });
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium text-text-primary">{TITLE}</p>
        <p className="mt-0.5 text-xs text-muted">{HELPER_TEXT}</p>
      </div>
      <p className="text-xs text-muted">{ACTION_REQUIRED_NOTE}</p>
      {isLoading ? (
        <Spinner className="py-2" />
      ) : (
        <div className="flex flex-col gap-2">
          <div aria-hidden className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-[11px] font-medium text-muted">
            <span className="w-11 shrink-0 text-center">{COLUMN_BELL}</span>
            <span className="w-11 shrink-0 text-center">{COLUMN_PUSH}</span>
          </div>
          {OPERATIONAL_NOTIFICATION_EVENT_ORDER.map((eventType) => {
            const pref = byType.get(eventType);
            if (!pref) return null;
            const label = operationalNotificationEventLabels[eventType];
            return (
              <div key={eventType} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
                <span className="text-sm text-text-primary">{label}</span>
                <div className="flex shrink-0 items-center gap-4">
                  <Switch
                    checked={pref.inAppEnabled}
                    disabled={mutation.isPending}
                    onChange={() => toggleInApp(pref)}
                    label={`${COLUMN_BELL}: ${label}`}
                  />
                  <Switch
                    checked={pref.pushEnabled}
                    disabled={mutation.isPending || !pref.inAppEnabled}
                    onChange={() => togglePush(pref)}
                    label={`${COLUMN_PUSH}: ${label}`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
