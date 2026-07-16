import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { getRepository, isDemoMode } from '../data';
import { APP_NAME, APP_TAGLINE, roleLabels } from '../domain/labels';
import type { Profile } from '../domain/types';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Spinner } from '../components/ui';

export default function LoginPage() {
  const { login, sessionExpired } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const demo = isDemoMode();

  // In demo mode the login screen doubles as the demo-user picker. This is an
  // explicitly labeled demo control, not real authentication.
  const { data: profiles, isLoading } = useQuery({
    queryKey: ['login-profiles'],
    queryFn: async () => {
      const repo = getRepository();
      if (repo.mode !== 'demo') return [] as Profile[];
      const demoRepo = repo as unknown as { listProfiles: (s: { userId: string; role: string }) => Promise<Profile[]> };
      return demoRepo.listProfiles({ userId: 'u-admin', role: 'system_admin' });
    },
  });

  const handleLogin = async (userId: string) => {
    try {
      await login(userId);
      navigate('/');
    } catch {
      setError('לא ניתן להתחבר עם משתמש זה.');
    }
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-neutral-100 px-4 py-10 dark:bg-neutral-950">
      <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex flex-col items-center gap-3">
          <span
            aria-hidden
            className="flex size-12 items-center justify-center rounded-2xl bg-brand-600 text-xl font-extrabold text-white dark:bg-brand-500"
          >
            N
          </span>
          <div className="text-center">
            <h1 className="text-2xl font-extrabold tracking-tight text-neutral-900 dark:text-neutral-50" data-testid="brand-name">
              {APP_NAME}
            </h1>
            <p className="mt-1 text-sm text-muted">{APP_TAGLINE}</p>
          </div>
        </div>

        {sessionExpired && (
          <div
            role="alert"
            className="mt-5 rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm text-orange-900 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200"
          >
            פג תוקף ההתחברות. יש להתחבר מחדש כדי להמשיך. נתונים שלא נשמרו נשמרו כטיוטה מקומית ככל שניתן.
          </div>
        )}

        {demo ? (
          <>
            <div className="mt-5 flex items-center justify-center gap-1.5 text-center text-xs font-medium text-orange-800 dark:text-orange-300">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-orange-500" />
              מצב הדגמה — בחירת משתמש פיקטיבי לצורך התנסות בלבד
            </div>
            {isLoading ? (
              <Spinner />
            ) : (
              <ul className="mt-4 flex flex-col gap-2">
                {(profiles ?? []).filter((p) => p.active).map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 rounded-xl border border-neutral-200 px-4 py-3 text-right hover:border-brand-400 hover:bg-brand-50 dark:border-neutral-700 dark:hover:border-brand-700 dark:hover:bg-brand-950"
                      onClick={() => handleLogin(p.id)}
                      data-testid={`login-${p.id}`}
                    >
                      <span
                        aria-hidden
                        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-sm font-bold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
                      >
                        {p.fullName.charAt(0)}
                      </span>
                      <span className="min-w-0 flex-1 font-medium">{p.fullName}</span>
                      <Badge color="neutral">{roleLabels[p.role]}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <div className="mt-6 text-center text-sm text-neutral-600 dark:text-neutral-300">
            <p>ההתחברות מתבצעת בהזמנה בלבד דרך ספק ההזדהות.</p>
            <Button className="mt-4 w-full" disabled>
              התחברות (נדרשת הגדרת Supabase)
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-3 text-center text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
      <p className="mt-4 max-w-md text-center text-xs text-neutral-400">
        אב־טיפוס להדגמה בלבד. נתונים פיקטיביים. פריסה מבצעית מחייבת אישור ובדיקת אבטחה נפרדים.
      </p>
    </div>
  );
}
