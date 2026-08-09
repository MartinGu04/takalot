// Explicit logout() vs passive markSessionExpired(): only the FORMER may run
// Push cleanup (see pushLogoutCleanup.ts and AuthContext.tsx's two logout()
// implementations). A minimal harness around the real AuthProvider/useAuth
// (rather than the full App shell already covered by supabaseAuth.test.tsx)
// keeps this focused on exactly that distinction.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './AuthContext';

type AuthListener = (event: string, session: unknown) => void;

const state: {
  session: { user: { id: string; email: string } } | null;
  listeners: AuthListener[];
} = { session: null, listeners: [] };

const mockAuth = {
  getSession: vi.fn(async () => ({ data: { session: state.session } })),
  onAuthStateChange: vi.fn((cb: AuthListener) => {
    state.listeners.push(cb);
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  }),
  signOut: vi.fn(async () => {
    state.session = null;
    for (const cb of state.listeners) cb('SIGNED_OUT', null);
    return { error: null };
  }),
};

const deletePushSubscription = vi.fn().mockResolvedValue(undefined);
const getProfile = vi.fn();

vi.mock('../data/supabase/client', () => ({
  getSupabaseClient: () => ({ auth: mockAuth }),
}));

vi.mock('../data', () => ({
  isDemoMode: () => false,
  getRepository: () => ({
    mode: 'supabase',
    getProfile: (...args: unknown[]) => getProfile(...args),
    claimPendingProfile: async () => null,
    bootstrapFirstAdmin: async () => null,
    setOwnAvatarUrl: async () => {},
    deletePushSubscription,
  }),
}));

const ACTIVE_PROFILE = {
  id: 'auth-user-1',
  fullName: 'משתמש אמיתי',
  role: 'shift_supervisor',
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function Harness() {
  const { user, logout, markSessionExpired } = useAuth();
  return (
    <div>
      <span data-testid="user-id">{user?.id ?? 'none'}</span>
      <button onClick={logout}>do-logout</button>
      <button onClick={markSessionExpired}>do-expire</button>
    </div>
  );
}

function renderHarness() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider>
        <Harness />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.session = { user: { id: 'auth-user-1', email: 'real@example.com' } };
  state.listeners = [];
  deletePushSubscription.mockClear();
  mockAuth.signOut.mockClear();
  getProfile.mockResolvedValue(ACTIVE_PROFILE);

  const subscription = { endpoint: 'https://push.example.com/device-1', unsubscribe: vi.fn().mockResolvedValue(true) };
  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      getRegistration: vi.fn().mockResolvedValue({
        pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) },
      }),
    },
    configurable: true,
  });
});

describe('explicit logout() runs Push cleanup before signOut()', () => {
  it('calls Repository.deletePushSubscription for the signed-in user, then still signs out', async () => {
    const user = userEvent.setup();
    renderHarness();
    await waitFor(() => expect(screen.getByTestId('user-id')).toHaveTextContent('auth-user-1'));

    await user.click(screen.getByText('do-logout'));

    await waitFor(() => expect(deletePushSubscription).toHaveBeenCalledWith(
      { userId: 'auth-user-1', role: 'shift_supervisor' },
      'https://push.example.com/device-1',
    ));
    await waitFor(() => expect(mockAuth.signOut).toHaveBeenCalled());
  });

  it('a server-side cleanup failure never blocks signOut()', async () => {
    deletePushSubscription.mockRejectedValueOnce(new Error('server unreachable'));
    const user = userEvent.setup();
    renderHarness();
    await waitFor(() => expect(screen.getByTestId('user-id')).toHaveTextContent('auth-user-1'));

    await user.click(screen.getByText('do-logout'));

    await waitFor(() => expect(mockAuth.signOut).toHaveBeenCalled());
  });

  it('a hanging cleanup (Service Worker never resolves) does not prevent signOut() from eventually firing', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { getRegistration: () => new Promise(() => {}) },
      configurable: true,
    });
    const user = userEvent.setup();
    renderHarness();
    await waitFor(() => expect(screen.getByTestId('user-id')).toHaveTextContent('auth-user-1'));

    await user.click(screen.getByText('do-logout'));

    await waitFor(() => expect(mockAuth.signOut).toHaveBeenCalled(), { timeout: 5000 });
  }, 8000);
});

describe('passive markSessionExpired() never runs Push cleanup', () => {
  it('does not call Repository.deletePushSubscription', async () => {
    const user = userEvent.setup();
    renderHarness();
    await waitFor(() => expect(screen.getByTestId('user-id')).toHaveTextContent('auth-user-1'));

    await user.click(screen.getByText('do-expire'));

    await waitFor(() => expect(mockAuth.signOut).toHaveBeenCalled());
    expect(deletePushSubscription).not.toHaveBeenCalled();
  });
});
