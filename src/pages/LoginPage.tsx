import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { getRepository, isDemoMode } from '../data';
import { APP_NAME, APP_TAGLINE } from '../domain/labels';
import type { Profile } from '../domain/types';
import { useQuery } from '@tanstack/react-query';
import { Spinner } from '../components/ui';
import { RoleBadge } from '../components/RoleBadge';
import { AvariaAuthBrandPanel, AvariaLoginAtmosphere, AvariaUnitLogosCorner } from '../components/AvariaBrand';
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
    <div className="relative isolate flex min-h-dvh w-full flex-col overflow-hidden bg-[#070512] lg:flex-row">
      <AvariaLoginAtmosphere />
      <AvariaUnitLogosCorner />
      <AvariaAuthBrandPanel titleTestId="brand-name" animate />

      <div className="relative z-10 flex flex-1 flex-col justify-center overflow-y-auto px-6 pt-5 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:px-10 sm:py-12 lg:px-14 lg:py-12 xl:px-16">
        {/* A soft, localized glow behind the primary content -- illumination
            focused on what matters, not a flat wash across the column. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-600/10 blur-[120px]"
        />
        <div
          data-testid="auth-entrance-panel"
          className="relative mx-auto w-full max-w-2xl py-2 [animation:login-entrance_380ms_ease-out_140ms_both]"
        >
          <span className="inline-flex items-center rounded-full border border-brand-400/50 bg-brand-500/20 px-4 py-1.5 text-sm font-semibold text-brand-100">
            ברוכים הבאים
          </span>
          <h2 className="mt-6 text-5xl font-black leading-[1.05] tracking-tight text-white sm:text-7xl lg:text-6xl xl:text-7xl">
            כניסה למערכת
          </h2>
          <p className="mt-4 text-lg text-white/75 sm:text-xl">
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
              <div className="mt-7 flex items-center gap-2 text-sm font-medium text-white/60">
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-orange-500" />
                מצב הדגמה — בחירת משתמש פיקטיבי לצורך התנסות בלבד
              </div>
              {isLoading ? (
                <div className="mt-6">
                  <Spinner />
                </div>
              ) : (
                <ul className="mt-5 flex flex-col gap-2.5 [animation:login-entrance_320ms_ease-out_260ms_both]">
                  {(profiles ?? []).filter((p) => p.active).map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-5 py-3.5 text-right backdrop-blur-sm transition-colors hover:bg-white/10"
                        onClick={() => handleDemoLogin(p.id)}
                        data-testid={`login-${p.id}`}
                      >
                        <span
                          aria-hidden
                          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-base font-bold text-white"
                        >
                          {p.fullName.charAt(0)}
                        </span>
                        <span className="min-w-0 flex-1 text-base font-medium text-white">{p.fullName}</span>
                        <RoleBadge role={p.role} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <div className="mt-9">
              <button
                type="button"
                className="flex min-h-16 w-full items-center justify-center gap-3 rounded-xl bg-white px-5 py-4 text-lg font-semibold text-gray-900 shadow-[0_16px_44px_-12px_rgba(0,0,0,0.75)] transition-colors [animation:login-entrance_320ms_ease-out_260ms_both] hover:bg-gray-50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70 disabled:active:scale-100"
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

              <div className="mt-7 flex items-center gap-4 text-sm text-white/55">
                <span className="h-px flex-1 bg-white/20" />
                או
                <span className="h-px flex-1 bg-white/20" />
              </div>

              <div className="mt-5 flex items-start gap-3.5 rounded-2xl border border-brand-400/25 bg-brand-500/10 p-4 backdrop-blur-md">
                <span
                  aria-hidden
                  className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-500/20 text-brand-200"
                >
                  <IconLock className="size-5" />
                </span>
                <p className="text-sm text-white/80">
                  הגישה בהזמנה בלבד: התחברות Google מזהה אתכם, אך נדרש גם פרופיל משתמש פעיל שהוגדר על ידי
                  מנהל המערכת.
                </p>
              </div>

              <div className="mt-5 flex items-center justify-center gap-2 text-sm text-white/55">
                <IconShield className="size-4" aria-hidden />
                מאובטח ברמה גבוהה
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-4 text-center text-sm text-red-400">
              {error}
            </p>
          )}

          {demo && (
            <p className="mt-6 text-center text-xs text-white/45">
              אב־טיפוס להדגמה בלבד. נתונים פיקטיביים. פריסה מבצעית מחייבת אישור ובדיקת אבטחה נפרדים.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
