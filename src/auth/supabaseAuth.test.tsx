// Supabase-mode authentication/authorization lifecycle, exercised through
// the real App shell with the Supabase client and repository mocked at the
// module seams. Covers: session restoration without a login-page flash,
// Google-identity-without-profile => unauthorized screen (identity is not
// authorization), transient profile-check failure => retryable error screen
// (NOT unauthorized), and logout clearing back to the login screen.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

type AuthListener = (event: string, session: unknown) => void;

const state: {
  session: { user: { id: string; email: string } } | null;
  listeners: AuthListener[];
  getProfile: ReturnType<typeof vi.fn>;
  claimPending: ReturnType<typeof vi.fn>;
  bootstrapAdmin: ReturnType<typeof vi.fn>;
} = {
  session: null,
  listeners: [],
  getProfile: vi.fn(),
  claimPending: vi.fn(),
  bootstrapAdmin: vi.fn(),
};

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
  signInWithOAuth: vi.fn(async () => ({ data: {}, error: null })),
};

vi.mock('../data/appMode', () => ({
  getAppMode: () => ({ kind: 'supabase', url: 'https://example.supabase.co', publishableKey: 'k.e.y' }),
}));

vi.mock('../data/supabase/client', () => ({
  getSupabaseClient: () => ({ auth: mockAuth }),
}));

vi.mock('../data', () => ({
  isDemoMode: () => false,
  getRepository: () => ({
    mode: 'supabase',
    getProfile: (...args: unknown[]) => state.getProfile(...args),
    claimPendingProfile: (...args: unknown[]) => state.claimPending(...args),
    bootstrapFirstAdmin: (...args: unknown[]) => state.bootstrapAdmin(...args),
    listProfiles: async () => [],
    listSystems: async () => [],
    listLocations: async () => [],
    listIncidents: async () => [],
    listNotifications: async () => [],
    listHandovers: async () => [],
    canExport: async () => false,
  }),
}));

import App from '../App';

const ACTIVE_PROFILE = {
  id: 'auth-user-1',
  fullName: 'משתמש אמיתי',
  role: 'shift_supervisor',
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  state.session = null;
  state.listeners = [];
  state.getProfile = vi.fn();
  state.claimPending = vi.fn().mockResolvedValue(null);
  state.bootstrapAdmin = vi.fn().mockResolvedValue(null);
  mockAuth.signInWithOAuth.mockClear();
  mockAuth.signOut.mockClear();
  window.history.pushState({}, '', '/');
});

describe('supabase mode: signed out', () => {
  it('shows the Google login button, never the demo user picker', async () => {
    render(<App />);
    expect(await screen.findByTestId('google-login-button')).toBeInTheDocument();
    expect(screen.queryByText(/מצב הדגמה/)).not.toBeInTheDocument();
    expect(screen.queryByTestId(/^login-u-/)).not.toBeInTheDocument();
  });

  it('starts the Google OAuth flow on click', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('google-login-button'));
    expect(mockAuth.signInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google' }),
    );
  });

  it('redirects a protected route to the login screen', async () => {
    window.history.pushState({}, '', '/incidents');
    render(<App />);
    expect(await screen.findByTestId('google-login-button')).toBeInTheDocument();
  });
});

describe('supabase mode: session restoration', () => {
  it('shows the auth splash (not the login page) while the profile check is in flight, then the app', async () => {
    state.session = { user: { id: 'auth-user-1', email: 'real@example.com' } };
    let release!: (v: typeof ACTIVE_PROFILE) => void;
    state.getProfile.mockReturnValue(new Promise((resolve) => (release = resolve)));

    render(<App />);
    expect(await screen.findByTestId('auth-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('google-login-button')).not.toBeInTheDocument();

    release(ACTIVE_PROFILE);
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
    expect(state.getProfile).toHaveBeenCalledWith('auth-user-1');
    // An already-linked profile never triggers a claim attempt.
    expect(state.claimPending).not.toHaveBeenCalled();
  });
});

describe('supabase mode: pre-provisioned first sign-in', () => {
  it('claims the pending entry automatically (no client-supplied identity), re-confirms through the profile read, and enters the app', async () => {
    const claimedProfile = { ...ACTIVE_PROFILE, id: 'auth-new-1', role: 'technician' };
    state.session = { user: { id: 'auth-new-1', email: 'new.person@example.com' } };
    // First read: no profile yet. After the claim, the SAME authorization
    // path must confirm the now-existing active profile.
    state.getProfile.mockResolvedValueOnce(null).mockResolvedValue(claimedProfile);
    state.claimPending.mockResolvedValue(claimedProfile);

    render(<App />);
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
    // The claim call carries NO email/uuid/role -- the backend derives the
    // verified identity itself; the client has nothing to say about it.
    expect(state.claimPending).toHaveBeenCalledTimes(1);
    expect(state.claimPending).toHaveBeenCalledWith();
    // The gate re-confirmed via getProfile instead of trusting the claim's
    // return value.
    expect(state.getProfile).toHaveBeenCalledTimes(2);
    expect(state.getProfile).toHaveBeenLastCalledWith('auth-new-1');
    // A successful claim never reaches the bootstrap path.
    expect(state.bootstrapAdmin).not.toHaveBeenCalled();
  });

  it('stays unauthorized when the claim finds no matching entry', async () => {
    state.session = { user: { id: 'auth-stranger', email: 'stranger@example.com' } };
    state.getProfile.mockResolvedValue(null);
    state.claimPending.mockResolvedValue(null);

    render(<App />);
    expect(await screen.findByTestId('unauthorized-screen')).toBeInTheDocument();
    expect(state.claimPending).toHaveBeenCalledTimes(1);
    // No successful claim => no second profile read; one failed check is
    // enough to stay locked out.
    expect(state.getProfile).toHaveBeenCalledTimes(1);
  });

  it('does NOT trust the claim return value: a claim "success" that the profile read cannot confirm stays unauthorized', async () => {
    state.session = { user: { id: 'auth-ghost', email: 'ghost@example.com' } };
    // A buggy/compromised data layer answers the claim with a profile
    // object, but the RLS-guarded profile read still returns nothing --
    // the gate must side with the profile read.
    state.getProfile.mockResolvedValue(null);
    state.claimPending.mockResolvedValue({ ...ACTIVE_PROFILE, id: 'auth-ghost' });

    render(<App />);
    expect(await screen.findByTestId('unauthorized-screen')).toBeInTheDocument();
    expect(state.getProfile).toHaveBeenCalledTimes(2);
  });

  it('an INACTIVE existing profile cannot regain access through the claim path', async () => {
    state.session = { user: { id: 'auth-off-1', email: 'off.person@example.com' } };
    // The backend fails the claim closed for a deactivated profile (null),
    // and the profile read confirms nothing active exists.
    state.getProfile.mockResolvedValue(null);
    state.claimPending.mockResolvedValue(null);

    render(<App />);
    expect(await screen.findByTestId('unauthorized-screen')).toBeInTheDocument();
    // Even if a stale layer returned the inactive profile itself, the
    // active=false check keeps the gate closed -- proven separately below
    // in "treats an INACTIVE profile as unauthorized too".
  });
});

describe('supabase mode: first-administrator bootstrap (fresh database)', () => {
  it('the configured owner identity becomes the first system_admin on a normal Google sign-in', async () => {
    const adminProfile = { ...ACTIVE_PROFILE, id: 'auth-owner', role: 'system_admin' };
    state.session = { user: { id: 'auth-owner', email: 'owner@example.com' } };
    // Fresh database: no profile, no pending entry to claim -- then the
    // bootstrap succeeds and the SAME authorization path confirms it.
    state.getProfile.mockResolvedValueOnce(null).mockResolvedValue(adminProfile);
    state.claimPending.mockResolvedValue(null);
    state.bootstrapAdmin.mockResolvedValue(adminProfile);

    render(<App />);
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
    // Zero arguments: the client supplies no email/uuid/role -- the backend
    // verifies the configured address and Google identity server-side.
    expect(state.bootstrapAdmin).toHaveBeenCalledTimes(1);
    expect(state.bootstrapAdmin).toHaveBeenCalledWith();
    // The claim was tried first; bootstrap only runs when nothing claimed.
    expect(state.claimPending).toHaveBeenCalledTimes(1);
    expect(state.getProfile).toHaveBeenLastCalledWith('auth-owner');
  });

  it('a rejected bootstrap (wrong account, closed window, unverified identity) stays unauthorized', async () => {
    state.session = { user: { id: 'auth-not-owner', email: 'someone@example.com' } };
    state.getProfile.mockResolvedValue(null);
    state.claimPending.mockResolvedValue(null);
    state.bootstrapAdmin.mockResolvedValue(null); // fail closed

    render(<App />);
    expect(await screen.findByTestId('unauthorized-screen')).toBeInTheDocument();
    expect(state.bootstrapAdmin).toHaveBeenCalledTimes(1);
  });

  it('does NOT trust the bootstrap return value: a "success" the profile read cannot confirm stays unauthorized', async () => {
    state.session = { user: { id: 'auth-fake-owner', email: 'owner@example.com' } };
    state.getProfile.mockResolvedValue(null);
    state.claimPending.mockResolvedValue(null);
    state.bootstrapAdmin.mockResolvedValue({ ...ACTIVE_PROFILE, id: 'auth-fake-owner', role: 'system_admin' });

    render(<App />);
    expect(await screen.findByTestId('unauthorized-screen')).toBeInTheDocument();
    expect(state.getProfile).toHaveBeenCalledTimes(2);
  });
});

describe('supabase mode: identity without authorization', () => {
  it('shows the unauthorized screen (with the Google identity email) when no active profile exists', async () => {
    state.session = { user: { id: 'auth-user-9', email: 'stranger@example.com' } };
    state.getProfile.mockResolvedValue(null);

    render(<App />);
    expect(await screen.findByTestId('unauthorized-screen')).toBeInTheDocument();
    expect(screen.getByText('stranger@example.com')).toBeInTheDocument();
    // The application shell must not render for an unauthorized identity.
    expect(screen.queryByRole('navigation', { name: 'ניווט ראשי' })).not.toBeInTheDocument();
  });

  it('treats an INACTIVE profile as unauthorized too', async () => {
    state.session = { user: { id: 'auth-user-9', email: 'off@example.com' } };
    state.getProfile.mockResolvedValue({ ...ACTIVE_PROFILE, active: false });
    render(<App />);
    expect(await screen.findByTestId('unauthorized-screen')).toBeInTheDocument();
  });

  it('logout from the unauthorized screen signs out and returns to the login screen', async () => {
    const user = userEvent.setup();
    state.session = { user: { id: 'auth-user-9', email: 'stranger@example.com' } };
    state.getProfile.mockResolvedValue(null);

    render(<App />);
    await user.click(within(await screen.findByTestId('unauthorized-screen')).getByRole('button', { name: 'התנתקות' }));
    expect(mockAuth.signOut).toHaveBeenCalled();
    expect(await screen.findByTestId('google-login-button')).toBeInTheDocument();
  });
});

describe('supabase mode: profile check failure', () => {
  it('shows the retryable error screen (NOT unauthorized) and recovers on retry', async () => {
    const user = userEvent.setup();
    state.session = { user: { id: 'auth-user-1', email: 'real@example.com' } };
    state.getProfile.mockRejectedValueOnce(new Error('network down'));

    render(<App />);
    expect(await screen.findByTestId('auth-error-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('unauthorized-screen')).not.toBeInTheDocument();

    state.getProfile.mockResolvedValue(ACTIVE_PROFILE);
    await user.click(screen.getByRole('button', { name: 'ניסיון חוזר' }));
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
  });
});

describe('supabase mode: admin users page', () => {
  it('offers no create-user action and explains manual provisioning instead', async () => {
    state.session = { user: { id: 'auth-admin-1', email: 'admin@example.com' } };
    state.getProfile.mockResolvedValue({ ...ACTIVE_PROFILE, id: 'auth-admin-1', role: 'system_admin' });
    window.history.pushState({}, '', '/admin');

    render(<App />);
    // The manual-provisioning explanation replaces the demo-only create form.
    expect(await screen.findByTestId('user-provisioning-note')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'הוספת משתמש' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/שם מלא/)).not.toBeInTheDocument();
  });
});

describe('supabase mode: logout from the app', () => {
  it('clears back to the login screen', async () => {
    const user = userEvent.setup();
    state.session = { user: { id: 'auth-user-1', email: 'real@example.com' } };
    state.getProfile.mockResolvedValue(ACTIVE_PROFILE);

    render(<App />);
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
    await user.click(screen.getAllByRole('button', { name: 'התנתקות' })[0]);
    expect(mockAuth.signOut).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'מצב נוכחי' })).not.toBeInTheDocument());
    expect(await screen.findByTestId('google-login-button')).toBeInTheDocument();
  });
});
