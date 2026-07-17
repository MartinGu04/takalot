import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { isDemoMode } from '../data';
import { useNotifications, useProfiles, useAppMutation, repo } from '../data/hooks';
import { hasCapability } from '../domain/permissions';
import { APP_NAME, roleLabels, notificationTypeLabels } from '../domain/labels';
import { formatRelative } from '../lib/time';
import { useSession } from '../auth/AuthContext';
import { Sidebar } from './Sidebar';
import { ThemeToggle } from './ThemeToggle';
import { navItems } from './navItems';
import { IconBell, IconLogOut, IconPlus } from './icons';
import { NexusMark } from './NexusMark';
import { FloatingPopover } from './FloatingPopover';

function DemoBanner() {
  if (!isDemoMode()) return null;
  return (
    <div className="bg-orange-100 px-4 py-1.5 text-center text-xs font-medium text-orange-900 dark:bg-orange-950 dark:text-orange-200">
      מצב הדגמה — נתונים פיקטיביים בלבד, ללא חיבור לשרת מאובטח. אין להזין מידע אמיתי.
    </div>
  );
}

/** Demo-only role switcher. Rendered exclusively in demo mode; kept compact and quiet, not visually dominant. */
function RoleSwitcher() {
  const { user, switchUser } = useAuth();
  const { data: profiles } = useProfiles();
  if (!isDemoMode() || !user) return null;
  return (
    <label className="flex min-w-0 items-center gap-1 text-xs text-muted">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-orange-500" />
      <select
        aria-label="החלפת משתמש הדגמה"
        className="min-h-9 max-w-20 min-w-0 rounded-lg border border-hairline bg-transparent px-1 text-xs text-text-secondary hover:bg-surface-hover sm:max-w-40"
        value={user.id}
        onChange={(e) => switchUser(e.target.value)}
        data-testid="demo-role-switcher"
      >
        {(profiles ?? []).filter((p) => p.active).map((p) => (
          <option key={p.id} value={p.id}>
            {p.fullName} — {roleLabels[p.role]}
          </option>
        ))}
      </select>
    </label>
  );
}

function NotificationsMenu() {
  const [open, setOpen] = useState(false);
  const { data: notifications } = useNotifications();
  const session = useSession();
  const navigate = useNavigate();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const unread = (notifications ?? []).filter((n) => !n.read).length;

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
        width={320}
        maxHeight={384}
        className="popover-panel z-50 animate-scale-in overflow-y-auto p-2"
      >
        <div className="flex items-center justify-between px-2 py-1">
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
        {(notifications ?? []).length === 0 && (
          <p className="px-2 py-4 text-center text-sm text-muted">אין התראות.</p>
        )}
        {(notifications ?? []).slice(0, 30).map((n) => (
          <button
            key={n.id}
            type="button"
            className={`block w-full rounded-lg px-2 py-2 text-right text-sm hover:bg-surface-hover ${
              n.read ? 'opacity-60' : 'font-medium'
            }`}
            onClick={() => {
              if (!n.read) markRead.mutate(n.id);
              setOpen(false);
              if (n.incidentId) navigate(`/incidents/${n.incidentId}`);
              else if (n.handoverId) navigate(`/handovers/${n.handoverId}`);
            }}
          >
            <span className="block text-xs text-muted">
              {notificationTypeLabels[n.type]} · {formatRelative(n.createdAt)}
            </span>
            {n.text}
          </button>
        ))}
      </FloatingPopover>
    </>
  );
}

/** Mobile-only identity control: avatar opens a small menu with logout. Desktop shows this in the sidebar instead. */
function MobileUserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
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

  if (!user) return null;
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="flex size-10 items-center justify-center rounded-lg hover:bg-surface-hover"
        onClick={() => setOpen((o) => !o)}
        aria-label="תפריט משתמש"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="flex size-7 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-800 dark:bg-brand-950 dark:text-brand-200">
          {user.fullName.charAt(0)}
        </span>
      </button>
      <FloatingPopover
        anchorRef={anchorRef}
        panelRef={panelRef}
        open={open}
        width={208}
        className="popover-panel z-50 animate-scale-in p-2"
      >
        <p className="px-2 py-1 text-sm font-medium text-text-primary">
          {user.fullName}
          <span className="block text-xs text-muted">{roleLabels[user.role]}</span>
        </p>
        <div className="mt-1 flex items-center justify-between rounded-lg px-2 py-1.5">
          <span className="text-sm text-muted">מצב תצוגה</span>
          <ThemeToggle />
        </div>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-right text-sm text-red-700 hover:bg-surface-hover dark:text-red-400"
          onClick={logout}
        >
          <IconLogOut className="size-4" />
          התנתקות
        </button>
      </FloatingPopover>
    </>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return <>{children}</>;
  const items = navItems(user.role);
  const canCreate = hasCapability(user.role, 'create_incident');

  return (
    <div className="flex min-h-dvh">
      <Sidebar user={user} />
      <div className="flex min-h-dvh min-w-0 flex-1 flex-col">
        <DemoBanner />
        <header className="sticky top-0 z-40 border-b border-hairline bg-surface/90 backdrop-blur-sm">
          <div className="flex items-center gap-2 px-4 py-2">
            <Link to="/" className="flex min-w-0 items-center gap-2 md:hidden" data-testid="brand-name-mobile">
              <NexusMark className="size-7" />
              <span className="truncate text-base font-extrabold tracking-tight text-text-primary">{APP_NAME}</span>
            </Link>
            <div className="ms-auto flex min-w-0 items-center gap-1">
              <RoleSwitcher />
              <NotificationsMenu />
              <div className="md:hidden">
                <MobileUserMenu />
              </div>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-28 pt-4 md:pb-8">{children}</main>

        {/* Mobile bottom navigation (max 4 destinations) + prominent create action */}
        <nav
          aria-label="ניווט תחתון"
          className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-hairline bg-surface/95 backdrop-blur-sm pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          <div className="relative flex">
            {items.slice(0, 4).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium transition-colors ${
                    isActive ? 'text-brand-700 dark:text-brand-400' : 'text-muted'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={`flex size-7 items-center justify-center rounded-lg ${isActive ? 'bg-brand-50 dark:bg-brand-950' : ''}`}
                    >
                      <item.icon className={`size-5 ${isActive ? 'text-brand-600 dark:text-brand-400' : ''}`} />
                    </span>
                    {item.label}
                  </>
                )}
              </NavLink>
            ))}
            {canCreate && (
              <Link
                to="/incidents/new"
                aria-label="פתיחת תקלה חדשה"
                className="absolute -top-7 inset-x-0 mx-auto flex size-12 items-center justify-center rounded-full bg-brand-600 text-white shadow-lg hover:bg-brand-700 active:scale-95 dark:bg-brand-500"
              >
                <IconPlus className="size-6" />
              </Link>
            )}
          </div>
        </nav>
      </div>
    </div>
  );
}
