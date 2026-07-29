import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { getRepository, isDemoMode } from '../data';
import { APP_NAME, APP_TAGLINE } from '../domain/labels';
import type { Profile } from '../domain/types';
import { useQuery } from '@tanstack/react-query';
import { Button, Spinner } from '../components/ui';
import { RoleBadge } from '../components/RoleBadge';
import { AvariaAuthBrandPanel } from '../components/AvariaBrand';

/** Reads an OAuth provider error forwarded back on the redirect URL
 *  (Supabase passes failures as error/error_description in the query or
 *  hash). Returns a display message, or null when the landing is clean. */
function oauthErrorFromUrl(): string | null {
  const fromParams = (params: URLSearchParams) =>
    params.get('error_description') ?? (params.get('error') ? 'ההתחברות דרך Google נכשלה.' : null);
  const query = fromParams(new URLSearchParams(window.location.search));
  if (query) return query;
  const hash = window.location.hash.startsWith('#')
    ? fromParams(new URLSearchParams(window.location.hash.slice(1)))
    : null;
  return hash;
}

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.29 14.29A7.2 7.2 0 0 1 4.91 12c0-.8.14-1.57.38-2.29v-3.1H1.28a12 12 0 0 0 0 10.78l4.01-3.1z" />
      <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.6 4.58 1.79l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.61l4.01 3.1C6.23 6.88 8.88 4.77 12 4.77z" />
    </svg>
  );
}

export default function LoginPage() {
  const { login, loginWithGoogle, sessionExpired } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [redirecting, setRedirecting] = useState(false);
  const demo = isDemoMode();

  // Surface a provider failure carried back on the redirect (e.g. the user
  // canceled the Google consent screen).
  const oauthError = useMemo(() => (demo ? null : oauthErrorFromUrl()), [demo]);
  useEffect(() => {
    if (oauthError) setError(oauthError);
  }, [oauthError]);

  // In demo mode the login screen doubles as the demo-user picker. This is an
  // explicitly labeled demo control, not real authentication.
  const { data: profiles, isLoading } = useQuery({
    queryKey: ['login-profiles'],
    enabled: demo,
    queryFn: async () => {
      const repo = getRepository();
      if (repo.mode !== 'demo') return [] as Profile[];
      const demoRepo = repo as unknown as { listProfiles: (s: { userId: string; role: string }) => Promise<Profile[]> };
      return demoRepo.listProfiles({ userId: 'u-admin', role: 'system_admin' });
    },
  });

  const handleDemoLogin = async (userId: string) => {
    try {
      await login(userId);
      navigate('/');
    } catch {
      setError('לא ניתן להתחבר עם משתמש זה.');
    }
  };

  const handleGoogleLogin = async () => {
    setError('');
    setRedirecting(true);
    try {
      await loginWithGoogle();
      // The browser navigates away to Google; the spinner covers the gap.
    } catch {
      setRedirecting(false);
      setError('לא ניתן להתחיל את תהליך ההתחברות. יש לבדוק את החיבור ולנסות שוב.');
    }
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-6 sm:px-6 sm:py-10">
      <div className="grid w-full max-w-6xl overflow-hidden rounded-3xl border border-hairline bg-surface shadow-elevated lg:min-h-[38rem] lg:grid-cols-[minmax(0,1.08fr)_minmax(22rem,0.92fr)]">
        <AvariaAuthBrandPanel titleTestId="brand-name" />
        <div className="flex flex-col justify-center p-6 sm:p-10 lg:p-12">
          <div className="mx-auto w-full max-w-md">
            <p className="text-xs font-bold tracking-[0.18em] text-brand-700 dark:text-brand-300">
              {APP_NAME}
            </p>
            <h2 className="mt-2 text-2xl font-extrabold tracking-tight text-text-primary">כניסה למערכת</h2>
            <p className="mt-2 text-sm text-muted">{APP_TAGLINE}</p>

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
                <div className="mt-5 flex items-center gap-1.5 text-xs font-medium text-muted">
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-orange-500" />
                  מצב הדגמה — בחירת משתמש פיקטיבי לצורך התנסות בלבד
                </div>
                {isLoading ? (
                  <div className="mt-6">
                    <Spinner />
                  </div>
                ) : (
                  <ul className="mt-4 flex flex-col gap-2">
                    {(profiles ?? []).filter((p) => p.active).map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          className="surface-interactive flex w-full items-center gap-3 px-4 py-3 text-right"
                          onClick={() => handleDemoLogin(p.id)}
                          data-testid={`login-${p.id}`}
                        >
                          <span
                            aria-hidden
                            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-active text-sm font-bold text-text-primary"
                          >
                            {p.fullName.charAt(0)}
                          </span>
                          <span className="min-w-0 flex-1 font-medium text-text-primary">{p.fullName}</span>
                          <RoleBadge role={p.role} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <div className="mt-6 text-center">
                <Button
                  className="w-full justify-center gap-2.5"
                  onClick={handleGoogleLogin}
                  disabled={redirecting}
                  data-testid="google-login-button"
                >
                  {redirecting ? (
                    'מעביר להזדהות…'
                  ) : (
                    <>
                      <GoogleGlyph />
                      התחברות עם Google
                    </>
                  )}
                </Button>
                <p className="mt-4 text-xs text-muted">
                  הגישה בהזמנה בלבד: התחברות Google מזהה אתכם, אך נדרש גם פרופיל משתמש פעיל שהוגדר על ידי
                  מנהל המערכת.
                </p>
              </div>
            )}
            {error && (
              <p role="alert" className="mt-3 text-center text-sm text-red-700 dark:text-red-400">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
      {demo && (
        <p className="mt-4 max-w-2xl text-center text-xs text-muted">
          אב־טיפוס להדגמה בלבד. נתונים פיקטיביים. פריסה מבצעית מחייבת אישור ובדיקת אבטחה נפרדים.
        </p>
      )}
    </div>
  );
}
