import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { getRepository, isDemoMode } from '../data';
import { APP_NAME, APP_TAGLINE } from '../domain/labels';
import type { Profile } from '../domain/types';
import { useQuery } from '@tanstack/react-query';
import { Spinner } from '../components/ui';
import { RoleBadge } from '../components/RoleBadge';
import { AvariaAuthBrandPanel } from '../components/AvariaBrand';
import { IconLock, IconShield } from '../components/icons';

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
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas p-4 sm:p-6 lg:p-10">
      <div className="grid w-full overflow-hidden rounded-3xl border border-white/10 bg-[#0c0918] shadow-elevated [animation:login-entrance_380ms_ease-out_both] lg:h-[calc(100dvh-5rem)] lg:grid-cols-2">
        <AvariaAuthBrandPanel titleTestId="brand-name" animate />
        <div className="flex flex-col justify-center overflow-y-auto p-6 sm:p-10 lg:h-full lg:p-12">
          <div className="mx-auto w-full max-w-md py-2 [animation:login-entrance_380ms_ease-out_140ms_both]">
            <span className="inline-flex items-center rounded-full border border-brand-400/30 bg-brand-500/10 px-3 py-1 text-xs font-semibold text-brand-200">
              ברוכים הבאים
            </span>
            <h2 className="mt-4 text-2xl font-extrabold tracking-tight text-white sm:text-3xl">
              כניסה למערכת
            </h2>
            <p className="mt-2 text-sm text-white/60">
              <span className="font-bold text-brand-300">{APP_NAME}</span> {APP_TAGLINE}
            </p>

            {sessionExpired && (
              <div
                role="alert"
                className="mt-5 rounded-lg border border-orange-800/60 bg-orange-950/50 p-3 text-sm text-orange-200"
              >
                פג תוקף ההתחברות. יש להתחבר מחדש כדי להמשיך. נתונים שלא נשמרו נשמרו כטיוטה מקומית ככל שניתן.
              </div>
            )}

            {demo ? (
              <>
                <div className="mt-5 flex items-center gap-1.5 text-xs font-medium text-white/50">
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-orange-500" />
                  מצב הדגמה — בחירת משתמש פיקטיבי לצורך התנסות בלבד
                </div>
                {isLoading ? (
                  <div className="mt-6">
                    <Spinner />
                  </div>
                ) : (
                  <ul className="mt-4 flex flex-col gap-2 [animation:login-entrance_320ms_ease-out_260ms_both]">
                    {(profiles ?? []).filter((p) => p.active).map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-right transition-colors hover:bg-white/10"
                          onClick={() => handleDemoLogin(p.id)}
                          data-testid={`login-${p.id}`}
                        >
                          <span
                            aria-hidden
                            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-bold text-white"
                          >
                            {p.fullName.charAt(0)}
                          </span>
                          <span className="min-w-0 flex-1 font-medium text-white">{p.fullName}</span>
                          <RoleBadge role={p.role} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <div className="mt-6">
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center justify-center gap-2.5 rounded-lg bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.6)] transition-colors [animation:login-entrance_320ms_ease-out_260ms_both] hover:bg-gray-50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70 disabled:active:scale-100"
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
                </button>

                <div className="mt-5 flex items-center gap-3 text-xs text-white/40">
                  <span className="h-px flex-1 bg-white/10" />
                  או
                  <span className="h-px flex-1 bg-white/10" />
                </div>

                <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-white/10 bg-white/5 p-3">
                  <span
                    aria-hidden
                    className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-500/15 text-brand-300"
                  >
                    <IconLock className="size-4" />
                  </span>
                  <p className="text-xs text-white/60">
                    הגישה בהזמנה בלבד: התחברות Google מזהה אתכם, אך נדרש גם פרופיל משתמש פעיל שהוגדר על ידי
                    מנהל המערכת.
                  </p>
                </div>

                <div className="mt-4 flex items-center justify-center gap-1.5 text-xs text-white/40">
                  <IconShield className="size-3.5" aria-hidden />
                  מאובטח ברמה גבוהה
                </div>
              </div>
            )}
            {error && (
              <p role="alert" className="mt-3 text-center text-sm text-red-400">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
      {demo && (
        // At lg the shell already fills the viewport height budget exactly
        // (card height = 100dvh - outer padding); this caption is pinned as
        // an overlay there instead of adding flow height that would push
        // the page into vertical scroll. Below lg it sits in normal flow.
        <p className="mt-4 max-w-2xl text-center text-xs text-muted lg:fixed lg:inset-x-0 lg:bottom-2 lg:mx-auto lg:mt-0">
          אב־טיפוס להדגמה בלבד. נתונים פיקטיביים. פריסה מבצעית מחייבת אישור ובדיקת אבטחה נפרדים.
        </p>
      )}
    </div>
  );
}
