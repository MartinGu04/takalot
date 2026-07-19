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
} = {
  session: null,
  listeners: [],
  getProfile: vi.fn(),
  claimPending: vi.fn(),
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
  it('claims the pending entry automatically (no client-supplied identity) and enters the app', async () => {
    state.session = { user: { id: 'auth-new-1', email: 'new.person@example.com' } };
    state.getProfile.mockResolvedValue(null); // no profile yet
    state.claimPending.mockResolvedValue({ ...ACTIVE_PROFILE, id: 'auth-new-1', role: 'technician' });

    render(<App />);
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
    // The claim call carries NO email/uuid/role -- the backend derives the
    // verified identity itself; the client has nothing to say about it.
    expect(state.claimPending).toHaveBeenCalledTimes(1);
    expect(state.claimPending).toHaveBeenCalledWith();
  });

  it('stays unauthorized when the claim finds no matching entry', async () => {
    state.session = { user: { id: 'auth-stranger', email: 'stranger@example.com' } };
    state.getProfile.mockResolvedValue(null);
    state.claimPending.mockResolvedValue(null);

    render(<App />);
    expect(await screen.findByTestId('unauthorized-screen')).toBeInTheDocument();
    expect(state.claimPending).toHaveBeenCalledTimes(1);
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
