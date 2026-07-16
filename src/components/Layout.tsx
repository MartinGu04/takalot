import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { isDemoMode } from '../data';
import { useNotifications, useProfiles, useAppMutation, repo } from '../data/hooks';
import { hasCapability } from '../domain/permissions';
import { APP_NAME, roleLabels, notificationTypeLabels } from '../domain/labels';
import { formatRelative } from '../lib/time';
import { useSession } from '../auth/AuthContext';

function navItems(role: string) {
  const items = [
    { to: '/', label: 'מצב נוכחי' },
    { to: '/incidents', label: 'תקלות' },
    { to: '/handovers', label: 'העברת משמרת' },
    { to: '/archive', label: 'ארכיון' },
  ];
  if (role === 'system_admin') items.push({ to: '/admin', label: 'ניהול' });
  return items;
}

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
        className="min-h-9 max-w-28 min-w-0 rounded-lg border border-orange-300 bg-orange-50 px-2 text-xs sm:max-w-40 dark:border-orange-800 dark:bg-orange-950"
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
        className="relative rounded-lg p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        onClick={() => setOpen((o) => !o)}
        data-testid="notifications-button"
      >
        <span aria-hidden>🔔</span>
        {unread > 0 && (
          <span className="absolute -top-0.5 -left-0.5 flex size-4.5 min-w-4.5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 z-50 mt-1 max-h-96 w-80 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-sm font-bold">התראות</span>
            {unread > 0 && (
              <button
                type="button"
                className="text-xs text-blue-700 hover:underline dark:text-blue-400"
                onClick={() => markAll.mutate(undefined)}
              >
                סימון הכול כנקרא
              </button>
            )}
          </div>
          {(notifications ?? []).length === 0 && (
            <p className="px-2 py-4 text-center text-sm text-neutral-500">אין התראות.</p>
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
              <span className="block text-xs text-neutral-500">
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

function UserMenu() {
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

  const cycleTheme = () => {
    const current = localStorage.getItem('takalot-theme'); // null=auto
    const next = current === null ? 'light' : current === 'light' ? 'dark' : null;
    if (next) localStorage.setItem('takalot-theme', next);
    else localStorage.removeItem('takalot-theme');
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', next ? next === 'dark' : systemDark);
  };

  if (!user) return null;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="flex min-h-11 items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
        onClick={() => setOpen((o) => !o)}
        aria-label="תפריט משתמש"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-blue-100 text-sm font-bold text-blue-800 dark:bg-blue-950 dark:text-blue-300">
          {user.fullName.charAt(0)}
        </span>
        <span className="hidden max-w-28 text-right sm:block">
          <span className="block truncate font-medium leading-tight">{user.fullName}</span>
          <span className="block truncate text-xs leading-tight text-neutral-500">{roleLabels[user.role]}</span>
        </span>
      </button>
      {open && (
        <div className="absolute left-0 z-50 mt-1 w-56 rounded-xl border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          <p className="px-2 py-1 text-sm font-medium sm:hidden">
            {user.fullName}
            <span className="block text-xs text-neutral-500">{roleLabels[user.role]}</span>
          </p>
          <button
            type="button"
            className="block w-full rounded-lg px-2 py-2 text-right text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
            onClick={cycleTheme}
          >
            מצב תצוגה: בהיר / כהה / אוטומטי
          </button>
          <button
            type="button"
            className="block w-full rounded-lg px-2 py-2 text-right text-sm text-red-700 hover:bg-neutral-100 dark:text-red-400 dark:hover:bg-neutral-800"
            onClick={logout}
          >
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
    <div className="flex min-h-dvh flex-col">
      <DemoBanner />
      <header className="sticky top-0 z-40 border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-2">
          <Link to="/" className="shrink-0 text-lg font-bold">
            {APP_NAME}
          </Link>
          <nav aria-label="ניווט ראשי" className="hidden min-w-0 items-center gap-1 md:flex">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-2 text-sm font-medium ${
                    isActive
                      ? 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-white'
                      : 'text-neutral-600 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-800'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ms-auto flex min-w-0 flex-wrap items-center gap-1.5">
            {canCreate && (
              <Link
                to="/incidents/new"
                className="hidden min-h-10 items-center rounded-lg bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 sm:inline-flex dark:bg-blue-600"
              >
                + פתיחת תקלה
              </Link>
            )}
            <RoleSwitcher />
            <NotificationsMenu />
            <UserMenu />
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
                `flex min-h-14 flex-1 flex-col items-center justify-center px-1 text-[11px] font-medium ${
                  isActive ? 'text-blue-700 dark:text-blue-400' : 'text-neutral-500'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
          {canCreate && (
            <Link
              to="/incidents/new"
              aria-label="פתיחת תקלה חדשה"
              className="absolute -top-6 left-3 flex size-12 items-center justify-center rounded-full bg-blue-700 text-2xl font-bold text-white shadow-lg hover:bg-blue-800 dark:bg-blue-600"
            >
              +
            </Link>
          )}
        </div>
      </nav>
    </div>
  );
}
