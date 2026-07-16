import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Profile } from '../domain/types';
import type { Session } from '../data/repository';
import { getRepository } from '../data';

const SESSION_KEY = 'takalot-demo-session-user';

interface AuthState {
  user: Profile | null;
  session: Session | null;
  loading: boolean;
  sessionExpired: boolean;
  login: (userId: string) => Promise<void>;
  logout: () => void;
  /** Demo-only role switching (switches the demo user). */
  switchUser: (userId: string) => Promise<void>;
  markSessionExpired: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);

  const loadUser = useCallback(async (userId: string): Promise<boolean> => {
    const profile = await getRepository().getProfile(userId);
    if (!profile || !profile.active) return false;
    setUser(profile);
    return true;
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem(SESSION_KEY);
    if (!stored) {
      setLoading(false);
      return;
    }
    loadUser(stored)
      .then((ok) => {
        if (!ok) {
          localStorage.removeItem(SESSION_KEY);
          setSessionExpired(true);
        }
      })
      .finally(() => setLoading(false));
  }, [loadUser]);

  const login = useCallback(
    async (userId: string) => {
      const ok = await loadUser(userId);
      if (!ok) throw new Error('המשתמש אינו זמין');
      localStorage.setItem(SESSION_KEY, userId);
      setSessionExpired(false);
    },
    [loadUser],
  );

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    setUser(null);
    setSessionExpired(false);
  }, []);

  const markSessionExpired = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    setUser(null);
    setSessionExpired(true);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      session: user ? { userId: user.id, role: user.role } : null,
      loading,
      sessionExpired,
      login,
      logout,
      switchUser: login,
      markSessionExpired,
    }),
    [user, loading, sessionExpired, login, logout, markSessionExpired],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
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
