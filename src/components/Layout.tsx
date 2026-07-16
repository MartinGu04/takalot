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

function DemoBanner() {
  if (!isDemoMode()) return null;
  return (
    <div className="bg-orange-100 px-4 py-1.5 text-center text-xs font-medium text-orange-900 dark:bg-orange-950 dark:text-orange-200">
      מצב הדגמה — נתונים פיקטיביים בלבד, ללא חיבור לשרת מאובטח. אין להזין מידע אמיתי.
    </div>
  );
}

/** Demo-only role switcher. Rendered exclusively in demo mode. */
function RoleSwitcher() {
  const { user, switchUser } = useAuth();
  const { data: profiles } = useProfiles();
  if (!isDemoMode() || !user) return null;
  return (
    <label className="flex min-w-0 items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
      <span className="hidden lg:inline">החלפת תפקיד (הדגמה):</span>
      <select
        aria-label="החלפת משתמש הדגמה"
        className="min-h-9 max-w-20 min-w-0 rounded-lg border border-orange-300 bg-orange-50 px-1.5 text-xs sm:max-w-40 dark:border-orange-800 dark:bg-orange-950"
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
  const ref = useRef<HTMLDivElement>(null);
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
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={`התראות${unread ? ` (${unread} שלא נקראו)` : ''}`}
        className="relative flex size-10 items-center justify-center rounded-lg text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
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
      {open && (
        <div className="absolute start-0 z-50 mt-1 max-h-96 w-80 animate-scale-in overflow-y-auto rounded-xl border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-sm font-bold">התראות</span>
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
              className={`block w-full rounded-lg px-2 py-2 text-right text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
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
        </div>
      )}
    </div>
  );
}

/** Mobile-only identity control: avatar opens a small menu with logout. Desktop shows this in the sidebar instead. */
function MobileUserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (!user) return null;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="flex size-10 items-center justify-center rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800"
        onClick={() => setOpen((o) => !o)}
        aria-label="תפריט משתמש"
      >
        <span className="flex size-7 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-800 dark:bg-brand-950 dark:text-brand-200">
          {user.fullName.charAt(0)}
        </span>
      </button>
      {open && (
        <div className="absolute start-0 z-50 mt-1 w-52 animate-scale-in rounded-xl border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          <p className="px-2 py-1 text-sm font-medium">
            {user.fullName}
            <span className="block text-xs text-muted">{roleLabels[user.role]}</span>
          </p>
          <div className="mt-1 flex items-center justify-between rounded-lg px-2 py-1.5">
            <span className="text-sm text-muted">מצב תצוגה</span>
            <ThemeToggle />
          </div>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-right text-sm text-red-700 hover:bg-neutral-100 dark:text-red-400 dark:hover:bg-neutral-800"
            onClick={logout}
          >
            <IconLogOut className="size-4" />
            התנתקות
          </button>
        </div>
      )}
    </div>
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
        <header className="sticky top-0 z-40 border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex items-center gap-2 px-4 py-2">
            <Link to="/" className="flex min-w-0 items-center gap-2 md:hidden" data-testid="brand-name-mobile">
              <span
                aria-hidden
                className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-xs font-extrabold text-white dark:bg-brand-500"
              >
                N
              </span>
              <span className="truncate text-base font-extrabold tracking-tight">{APP_NAME}</span>
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

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24 pt-4 md:pb-8">{children}</main>

        {/* Mobile bottom navigation (max 4 destinations) + prominent create action */}
        <nav
          aria-label="ניווט תחתון"
          className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-neutral-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden dark:border-neutral-800 dark:bg-neutral-900"
        >
          <div className="relative flex">
            {items.slice(0, 4).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium ${
                    isActive ? 'text-brand-700 dark:text-brand-400' : 'text-neutral-500'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon className={`size-5 ${isActive ? 'text-brand-600 dark:text-brand-400' : ''}`} />
                    {item.label}
                  </>
                )}
              </NavLink>
            ))}
            {canCreate && (
              <Link
                to="/incidents/new"
                aria-label="פתיחת תקלה חדשה"
                className="absolute -top-6 left-3 flex size-12 items-center justify-center rounded-full bg-brand-600 text-white shadow-lg hover:bg-brand-700 active:scale-95 dark:bg-brand-500"
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
