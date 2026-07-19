// Authentication + authorization state.
//
// Two modes (resolved once by appMode.ts):
//   - supabase: real Google OAuth via Supabase Auth. Google proves IDENTITY
//     only -- it never authorizes access by itself. After sign-in, the user
//     must match an ACTIVE row in public.profiles (readable via RLS only by
//     active members, so an unprovisioned user reads nothing and lands in
//     the 'unauthorized' state). Roles come from that profiles row -- the
//     database is the source of truth, never the client.
//   - demo: the explicitly-enabled development/test fallback. A labeled
//     fictional-user picker, stored in localStorage. Unreachable in
//     production builds (appMode hard-fails there instead).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Profile } from '../domain/types';
import type { Session } from '../data/repository';
import { getRepository, isDemoMode } from '../data';
import { getSupabaseClient } from '../data/supabase/client';

const DEMO_SESSION_KEY = 'takalot-demo-session-user';

/**
 * - 'loading': restoring a persisted session (or exchanging an OAuth code).
 * - 'signed_out': no identity; show the login screen.
 * - 'unauthorized': identity proven (Google), but no active profiles row --
 *   access denied until an administrator provisions one.
 * - 'error': identity proven, but the profile check itself failed (network/
 *   database) -- retryable, NOT treated as unauthorized.
 * - 'active': identity proven and matched to an active profile; full app.
 */
export type AuthStatus = 'loading' | 'signed_out' | 'unauthorized' | 'error' | 'active';

interface AuthState {
  user: Profile | null;
  session: Session | null;
  status: AuthStatus;
  /** True while the initial session restoration is still in flight. */
  loading: boolean;
  sessionExpired: boolean;
  /** Identity email shown on the unauthorized screen (supabase mode). */
  identityEmail: string | null;
  /** Demo mode only: sign in as a fictional user. */
  login: (userId: string) => Promise<void>;
  /** Supabase mode only: start the Google OAuth redirect. */
  loginWithGoogle: () => Promise<void>;
  logout: () => void;
  /** Demo-only role switching (switches the demo user). */
  switchUser: (userId: string) => Promise<void>;
  markSessionExpired: () => void;
  /** Retry the profile check after a transient failure (status 'error'). */
  retryAuthorization: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

function DemoAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const queryClient = useQueryClient();

  const loadUser = useCallback(async (userId: string): Promise<boolean> => {
    const profile = await getRepository().getProfile(userId);
    if (!profile || !profile.active) return false;
    setUser(profile);
    return true;
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem(DEMO_SESSION_KEY);
    if (!stored) {
      setLoading(false);
      return;
    }
    loadUser(stored)
      .then((ok) => {
        if (!ok) {
          localStorage.removeItem(DEMO_SESSION_KEY);
          setSessionExpired(true);
        }
      })
      .finally(() => setLoading(false));
  }, [loadUser]);

  const login = useCallback(
    async (userId: string) => {
      const ok = await loadUser(userId);
      if (!ok) throw new Error('המשתמש אינו זמין');
      localStorage.setItem(DEMO_SESSION_KEY, userId);
      setSessionExpired(false);
    },
    [loadUser],
  );

  const logout = useCallback(() => {
    localStorage.removeItem(DEMO_SESSION_KEY);
    setUser(null);
    setSessionExpired(false);
    queryClient.clear();
  }, [queryClient]);

  const markSessionExpired = useCallback(() => {
    localStorage.removeItem(DEMO_SESSION_KEY);
    setUser(null);
    setSessionExpired(true);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      session: user ? { userId: user.id, role: user.role } : null,
      status: loading ? 'loading' : user ? 'active' : 'signed_out',
      loading,
      sessionExpired,
      identityEmail: null,
      login,
      loginWithGoogle: async () => {
        throw new Error('Google login is unavailable in demo mode');
      },
      logout,
      switchUser: login,
      markSessionExpired,
      retryAuthorization: () => {},
    }),
    [user, loading, sessionExpired, login, logout, markSessionExpired],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function SupabaseAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<Profile | null>(null);
  const [identityEmail, setIdentityEmail] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const queryClient = useQueryClient();
  // Serializes profile checks: a stale check must never overwrite the state
  // written by a newer auth event (e.g. SIGNED_OUT racing a slow fetch).
  const checkSeq = useRef(0);
  const lastAuthUserId = useRef<string | null>(null);

  const resolveProfile = useCallback(async (authUserId: string, email: string | null) => {
    const seq = ++checkSeq.current;
    setStatus('loading');
    setIdentityEmail(email);
    lastAuthUserId.current = authUserId;
    try {
      // RLS on public.profiles only returns rows to active members, so a
      // Google-authenticated user without an active provisioned profile
      // reads nothing here.
      let profile = await getRepository().getProfile(authUserId);
      if (seq !== checkSeq.current) return;
      if (!profile) {
        // First sign-in of a PRE-PROVISIONED person: attempt the secure
        // claim. The call carries no identity/email/role -- the backend
        // derives auth.uid() itself and matches the VERIFIED, CONFIRMED
        // Google email server-side against a live pending_personnel entry,
        // creating the profile with the preassigned role atomically. No
        // match => null, and the user stays unauthorized. Nothing is
        // auto-created from the Google identity alone.
        let claimed = await getRepository().claimPendingProfile();
        if (seq !== checkSeq.current) return;
        if (!claimed) {
          // Fresh-database edge: with zero profiles no pending entry can
          // exist, so the very first sign-in additionally attempts the
          // ONE-TIME first-administrator bootstrap. Also parameterless;
          // the backend verifies the configured email + Google identity
          // server-side, succeeds at most once ever, and fails closed for
          // everyone else -- this is not self-registration.
          claimed = await getRepository().bootstrapFirstAdmin();
          if (seq !== checkSeq.current) return;
        }
        if (claimed) {
          // The claim's return value is NOT trusted as authorization by
          // itself: re-confirm through the exact same path every session
          // uses -- the RLS-guarded profiles read. Only an active profile
          // visible there authorizes access.
          profile = await getRepository().getProfile(authUserId);
          if (seq !== checkSeq.current) return;
        }
      }
      if (profile && profile.active) {
        setUser(profile);
        setStatus('active');
        setSessionExpired(false);
      } else {
        setUser(null);
        setStatus('unauthorized');
      }
    } catch {
      if (seq !== checkSeq.current) return;
      // Network/database failure -- explicitly NOT 'unauthorized': a flaky
      // connection must not tell a legitimate user they have no access.
      setUser(null);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    const supabase = getSupabaseClient();
    let unmounted = false;

    // Initial restoration: getSession() reads the persisted session (and,
    // with detectSessionInUrl, completes an OAuth redirect landing).
    supabase.auth.getSession().then(({ data }) => {
      if (unmounted) return;
      const s = data.session;
      if (s?.user) {
        resolveProfile(s.user.id, s.user.email ?? null);
      } else {
        checkSeq.current++;
        setStatus('signed_out');
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (unmounted) return;
      if (event === 'SIGNED_OUT') {
        checkSeq.current++;
        setUser(null);
        setIdentityEmail(null);
        setStatus('signed_out');
        queryClient.clear();
        return;
      }
      if (session?.user && session.user.id !== lastAuthUserId.current) {
        // SIGNED_IN (fresh login or OAuth landing) or a user change.
        resolveProfile(session.user.id, session.user.email ?? null);
      }
      // TOKEN_REFRESHED with the same user: nothing to re-check -- the
      // profile row, not the token, is the authorization source.
    });

    return () => {
      unmounted = true;
      sub.subscription.unsubscribe();
    };
  }, [resolveProfile, queryClient]);

  const loginWithGoogle = useCallback(async () => {
    const supabase = getSupabaseClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/login` },
    });
    if (error) throw new Error(error.message);
    // On success the browser navigates away to Google; nothing more to do.
  }, []);

  const logout = useCallback(() => {
    // Clear local state immediately -- the UI must not wait on the network
    // round-trip -- then revoke the session server-side.
    checkSeq.current++;
    lastAuthUserId.current = null;
    setUser(null);
    setIdentityEmail(null);
    setStatus('signed_out');
    setSessionExpired(false);
    queryClient.clear();
    void getSupabaseClient().auth.signOut();
  }, [queryClient]);

  const markSessionExpired = useCallback(() => {
    checkSeq.current++;
    lastAuthUserId.current = null;
    setUser(null);
    setStatus('signed_out');
    setSessionExpired(true);
    queryClient.clear();
    void getSupabaseClient().auth.signOut();
  }, [queryClient]);

  const retryAuthorization = useCallback(() => {
    const id = lastAuthUserId.current;
    if (id) void resolveProfile(id, identityEmail);
  }, [resolveProfile, identityEmail]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      session: user ? { userId: user.id, role: user.role } : null,
      status,
      loading: status === 'loading',
      sessionExpired,
      identityEmail,
      login: async () => {
        throw new Error('Demo login is unavailable outside demo mode');
      },
      loginWithGoogle,
      logout,
      switchUser: async () => {
        throw new Error('User switching is a demo-only control');
      },
      markSessionExpired,
      retryAuthorization,
    }),
    [user, status, sessionExpired, identityEmail, loginWithGoogle, logout, markSessionExpired, retryAuthorization],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Mode is fixed for the app's lifetime (resolved once from the build env),
  // so this branch is stable across renders.
  if (isDemoMode()) return <DemoAuthProvider>{children}</DemoAuthProvider>;
  return <SupabaseAuthProvider>{children}</SupabaseAuthProvider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Returns a non-null session; only usable behind the auth guard. */
export function useSession(): Session {
  const { session } = useAuth();
  if (!session) throw new Error('No active session');
  return session;
}
