import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { hasCapability } from '../domain/permissions';
import { APP_NAME, roleLabels } from '../domain/labels';
import type { Profile } from '../domain/types';
import { navItems } from './navItems';
import { ThemeToggle } from './ThemeToggle';
import { IconLogOut, IconPlus } from './icons';
import { NexusMark } from './NexusMark';

/** Desktop RTL sidebar: brand, primary nav, and the current-user section. Hidden below md. */
export function Sidebar({ user }: { user: Profile }) {
  const { logout } = useAuth();
  const items = navItems(user.role);
  const canCreate = hasCapability(user.role, 'create_incident');

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-e border-hairline bg-surface md:flex">
      <Link to="/" className="flex items-center gap-2.5 px-4 pt-5 pb-4" data-testid="brand-name">
        <NexusMark className="size-9" />
        <span className="text-lg font-extrabold tracking-tight text-text-primary">{APP_NAME}</span>
      </Link>

      {canCreate && (
        <div className="px-3 pb-1">
          <Link
            to="/incidents/new"
            className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white shadow-[0_2px_10px_-2px] shadow-brand-600/50 hover:bg-brand-700 active:scale-[0.98] dark:bg-brand-500 dark:hover:bg-brand-400"
          >
            <IconPlus className="size-4" />
            פתיחת תקלה
          </Link>
        </div>
      )}

      <nav aria-label="ניווט ראשי" className="mt-4 flex flex-1 flex-col gap-1 overflow-y-auto px-2.5">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `group flex items-center gap-2.5 rounded-lg py-2 ps-2 pe-3 text-sm transition-colors ${
                isActive
                  ? 'bg-brand-50 font-semibold text-brand-900 dark:bg-brand-950/60 dark:text-brand-100'
                  : 'font-medium text-text-secondary hover:bg-surface-hover hover:text-text-primary'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={`flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
                    isActive
                      ? 'bg-brand-600 text-white shadow-[0_2px_8px_-1px] shadow-brand-600/50 dark:bg-brand-500'
                      : 'bg-surface-active text-text-muted group-hover:text-text-secondary'
                  }`}
                >
                  <item.icon className="size-4.5" />
                </span>
                <span className="truncate">{item.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-hairline p-2.5">
        <div className="flex items-center gap-2 rounded-xl bg-surface-active/60 p-2">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-sm font-bold text-white"
          >
            {user.fullName.charAt(0)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-text-primary">{user.fullName}</p>
            <p className="truncate text-xs text-muted">{roleLabels[user.role]}</p>
          </div>
          <ThemeToggle />
          <button
            type="button"
            onClick={logout}
            aria-label="התנתקות"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-surface-hover hover:text-red-700 dark:hover:text-red-400"
          >
            <IconLogOut className="size-4.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
