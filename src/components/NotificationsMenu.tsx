// Compact notification center for the header bell -- redesigned from a flat
// list into filtered ("הכול" / "דורש פעולה" / "עדכונים") sections while
// keeping the exact same trigger location/behavior (bell icon + unread
// badge in the header). Data comes from listNotifications, which already
// excludes legacy 'update_overdue' rows and is server/repo-bounded -- this
// component never fetches unbounded history.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../auth/AuthContext';
import { useNotifications, useAppMutation, repo } from '../data/hooks';
import { notificationTypeLabels, notificationFilterLabels, type NotificationFilter } from '../domain/labels';
import type { AppNotification, NotificationType } from '../domain/types';
import { formatRelative } from '../lib/time';
import { FloatingPopover } from './FloatingPopover';
import {
  IconBell,
  IconPulse,
  IconWrench,
  IconCheck,
  IconArrowsExchange,
  IconTrash,
  IconFlag,
  IconHeadset,
  IconClock,
} from './icons';

const FILTERS: NotificationFilter[] = ['all', 'action_required', 'update'];

/** One icon per notification type, so the bell reads at a glance without
 *  opening each row. 'update_overdue' is never actually rendered (excluded
 *  by every repository's listNotifications), kept only for Record
 *  completeness against NotificationType. */
const notificationIcon: Record<NotificationType, typeof IconBell> = {
  incident_opened: IconPulse,
  incident_updated: IconWrench,
  incident_closed: IconCheck,
  incident_reopened: IconArrowsExchange,
  incident_cancelled: IconTrash,
  incident_assigned: IconFlag,
  handover_pending: IconHeadset,
  update_overdue: IconClock,
};

const emptyStateText: Record<NotificationFilter, string> = {
  all: 'אין התראות.',
  action_required: 'אין התראות שדורשות פעולה.',
  update: 'אין עדכונים.',
};

function NotificationRow({ notification, onSelect }: { notification: AppNotification; onSelect: (n: AppNotification) => void }) {
  const Icon = notificationIcon[notification.type];
  return (
    <button
      type="button"
      onClick={() => onSelect(notification)}
      className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-right text-sm hover:bg-surface-hover"
    >
      <span
        aria-hidden
        className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ${
          notification.read
            ? 'bg-surface-active text-text-muted'
            : 'bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300'
        }`}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={notification.read ? 'font-normal text-text-secondary' : 'font-semibold text-text-primary'}>
            {notificationTypeLabels[notification.type]}
          </span>
          {!notification.read && (
            <span aria-label="לא נקרא" className="size-2 shrink-0 rounded-full bg-brand-600 dark:bg-brand-400" />
          )}
        </span>
        <span className="block text-text-secondary">{notification.text}</span>
        <span className="block text-xs text-muted">{formatRelative(notification.createdAt)}</span>
      </span>
    </button>
  );
}

export function NotificationsMenu() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const { data: notifications } = useNotifications();
  const session = useSession();
  const navigate = useNavigate();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const all = notifications ?? [];
  const unread = all.filter((n) => !n.read).length;
  const filtered = filter === 'all' ? all : all.filter((n) => n.category === filter);

  const markRead = useAppMutation(
    (id: string) => repo().markNotificationRead(session, id),
    { invalidate: [['notifications']] },
  );
  const markAll = useAppMutation(() => repo().markAllNotificationsRead(session), {
    invalidate: [['notifications']],
  });

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!anchorRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Every time the popover opens, start back at "הכול" -- a filter left
  // selected from a previous visit should never silently hide a brand-new
  // notification the next time the bell is opened.
  useEffect(() => {
    if (open) setFilter('all');
  }, [open]);

  function handleSelect(n: AppNotification) {
    if (!n.read) markRead.mutate(n.id);
    setOpen(false);
    if (n.incidentId) navigate(`/incidents/${n.incidentId}`);
    else if (n.handoverId) navigate(`/handovers/${n.handoverId}`);
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label={`התראות${unread ? ` (${unread} שלא נקראו)` : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="relative flex size-10 items-center justify-center rounded-lg text-text-secondary hover:bg-surface-hover"
        onClick={() => setOpen((o) => !o)}
        data-testid="notifications-button"
      >
        <IconBell className="size-5" />
        {unread > 0 && (
          <span className="absolute top-1 left-1 flex size-4.5 min-w-4.5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {unread}
          </span>
        )}
      </button>
      <FloatingPopover
        anchorRef={anchorRef}
        panelRef={panelRef}
        open={open}
        width={340}
        maxHeight={440}
        className="popover-panel z-50 flex animate-scale-in flex-col overflow-hidden p-0"
      >
        <div className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-2">
          <span className="card-title">התראות</span>
          {unread > 0 && (
            <button
              type="button"
              className="text-xs text-brand-700 hover:underline dark:text-brand-400"
              onClick={() => markAll.mutate(undefined)}
            >
              סימון הכול כנקרא
            </button>
          )}
        </div>
        <div role="group" aria-label="סינון התראות" className="flex gap-1 border-b border-hairline px-2 py-1.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                filter === f
                  ? 'bg-brand-600 text-white dark:bg-brand-500'
                  : 'text-text-secondary hover:bg-surface-hover'
              }`}
            >
              {notificationFilterLabels[f]}
            </button>
          ))}
        </div>
        <div className="overflow-y-auto p-2">
          {filtered.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-muted">{emptyStateText[filter]}</p>
          )}
          {filtered.map((n) => (
            <NotificationRow key={n.id} notification={n} onSelect={handleSelect} />
          ))}
        </div>
      </FloatingPopover>
    </>
  );
}
