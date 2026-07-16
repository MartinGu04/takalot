import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { hasCapability } from '../domain/permissions';
import { APP_NAME, roleLabels } from '../domain/labels';
import type { Profile } from '../domain/types';
import { navItems } from './navItems';
import { ThemeToggle } from './ThemeToggle';
import { IconLogOut, IconPlus } from './icons';

/** Desktop RTL sidebar: brand, primary nav, and the current-user section. Hidden below md. */
export function Sidebar({ user }: { user: Profile }) {
  const { logout } = useAuth();
  const items = navItems(user.role);
  const canCreate = hasCapability(user.role, 'create_incident');

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-e border-neutral-200 bg-white md:flex dark:border-neutral-800 dark:bg-neutral-950">
      <Link to="/" className="flex items-center gap-2 px-4 py-4" data-testid="brand-name">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-sm font-extrabold text-white dark:bg-brand-500"
        >
          N
        </span>
        <span className="text-lg font-extrabold tracking-tight text-neutral-900 dark:text-neutral-50">{APP_NAME}</span>
      </Link>

      {canCreate && (
        <div className="px-3">
          <Link
            to="/incidents/new"
            className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 active:scale-[0.98] dark:bg-brand-500 dark:hover:bg-brand-400"
          >
            <IconPlus className="size-4" />
            פתיחת תקלה
          </Link>
        </div>
      )}

      <nav aria-label="ניווט ראשי" className="mt-4 flex flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium ${
                isActive
                  ? 'bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-200'
                  : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-900 dark:hover:text-white'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <item.icon className={`size-5 shrink-0 ${isActive ? 'text-brand-600 dark:text-brand-400' : ''}`} />
                <span className="truncate">{item.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-800 dark:bg-brand-950 dark:text-brand-200"
          >
            {user.fullName.charAt(0)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user.fullName}</p>
            <p className="truncate text-xs text-muted">{roleLabels[user.role]}</p>
          </div>
          <ThemeToggle />
          <button
            type="button"
            onClick={logout}
            aria-label="התנתקות"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 hover:text-red-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-red-400"
          >
            <IconLogOut className="size-4.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
