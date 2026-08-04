// Personal system_admin opt-in to role-based operational notifications
// (see NotificationCategory / notify_operational_recipients). Rendered only
// for a signed-in system_admin -- a professional_manager already receives
// these unconditionally and has nothing to opt into, and every other role
// never becomes a recipient. Shared between the desktop Sidebar account
// card and the mobile user menu so behavior and accessibility never
// diverge between the two placements.
import { useAuth, useSession } from '../auth/AuthContext';
import { useAppMutation, repo } from '../data/hooks';
import { Switch } from './ui';

const LABEL = 'עדכונים תפעוליים';
const SUPPORTING_TEXT = 'פתיחה, עדכון, סגירה, פתיחה מחדש וביטול תקלות';

export function OperationalNotificationsSwitch({ variant = 'card' }: { variant?: 'card' | 'compact' }) {
  const { user, updateUser } = useAuth();
  const session = useSession();

  const mutation = useAppMutation(
    (enabled: boolean) => repo().setMyOperationalNotificationsEnabled(session, enabled),
    {
      // Not optimistic: the switch stays at its current (correct) value
      // until the mutation actually succeeds, so a failure never needs an
      // explicit rollback -- there is nothing to undo. onSuccess refreshes
      // the signed-in user's own cached profile immediately, with no
      // logout or reload, and ['profiles'] is invalidated too for any
      // other view (e.g. personnel listings) reading the same row.
      invalidate: [['profiles']],
      onSuccess: (profile) => updateUser(profile),
    },
  );

  if (!user || user.role !== 'system_admin') return null;
  const checked = user.operationalNotificationsEnabled ?? false;

  if (variant === 'compact') {
    return (
      <div className="mt-1 flex items-center justify-between rounded-lg px-2 py-1.5">
        <span className="text-sm text-muted">{LABEL}</span>
        <Switch checked={checked} disabled={mutation.isPending} onChange={() => mutation.mutate(!checked)} label={LABEL} />
      </div>
    );
  }

  return (
    <div className="mt-2.5 flex items-start justify-between gap-3 border-t border-hairline pt-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">{LABEL}</p>
        <p className="mt-0.5 text-xs text-muted">{SUPPORTING_TEXT}</p>
      </div>
      <Switch checked={checked} disabled={mutation.isPending} onChange={() => mutation.mutate(!checked)} label={LABEL} />
    </div>
  );
}
