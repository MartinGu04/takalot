// Personal system_admin opt-in to role-based operational notifications
// (see NotificationCategory / notify_operational_recipients). Rendered only
// for a signed-in system_admin -- a professional_manager already receives
// these unconditionally and has nothing to opt into, and every other role
// never becomes a recipient. Lives inside the "הגדרות התראות" dialog opened
// from the notification-center gear (see NotificationsMenu) -- not in the
// account/user-menu areas, so there is exactly one access point.
import { useAuth, useSession } from '../auth/AuthContext';
import { useAppMutation, repo } from '../data/hooks';
import { Switch } from './ui';

const LABEL = 'עדכונים תפעוליים';
const SUPPORTING_TEXT = 'פתיחה, עדכון, סגירה, פתיחה מחדש וביטול תקלות';

export function OperationalNotificationsSwitch() {
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

  return (
    // Desktop (sm and up): unchanged from before -- a plain two-item row,
    // the label+text block on one side and the switch pushed to the far
    // edge (border/rounded-none/bg-transparent/p-0 all cancel the mobile
    // card below `sm:`). Below `sm`: one compact settings card (padded,
    // rounded, subtle surface/border) with the label and switch sharing a
    // close top row and the supporting text wrapping full-width beneath --
    // a genuinely different pairing of the same three pieces per
    // breakpoint, not just a spacing tweak, so this uses CSS grid areas
    // (arbitrary Tailwind properties) rather than duplicating any markup.
    <div
      data-testid="operational-notifications-card"
      className="rounded-xl border border-hairline bg-surface-active/40 p-3 sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0"
    >
      <div
        data-testid="operational-notifications-grid"
        className={[
          // Mobile: three columns -- label and switch each size to their
          // own content and sit packed together, with the 3rd (1fr) column
          // absorbing all leftover width so nothing stretches BETWEEN them.
          // The text row ignores that split and spans all three columns.
          'grid grid-cols-[auto_auto_1fr] items-center gap-x-3 gap-y-1',
          '[grid-template-areas:"label_switch_."_"text_text_text"]',
          // Desktop: unchanged from before -- two columns, label+text in
          // column 1, switch spanning both rows in column 2 (top-aligned).
          'sm:grid-cols-[1fr_auto] sm:items-start sm:gap-y-0',
          'sm:[grid-template-areas:"label_switch"_"text_switch"]',
        ].join(' ')}
      >
        <p className="[grid-area:label] min-w-0 text-sm font-medium text-text-primary">{LABEL}</p>
        <p className="[grid-area:text] min-w-0 text-xs text-muted sm:mt-0.5">{SUPPORTING_TEXT}</p>
        <div className="[grid-area:switch] self-start">
          <Switch checked={checked} disabled={mutation.isPending} onChange={() => mutation.mutate(!checked)} label={LABEL} />
        </div>
      </div>
    </div>
  );
}
