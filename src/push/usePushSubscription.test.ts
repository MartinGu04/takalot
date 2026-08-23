// usePushSubscription: the client Push state machine. Browser Push APIs
// (Notification, navigator.serviceWorker, PushManager) do not exist in
// jsdom, so every test installs its own minimal stand-ins -- see
// installPushGlobals below -- while the repository/toast/auth/PWA-update
// seams are mocked at the module boundary, matching this codebase's existing
// hook-test convention (see src/pwa/usePwaUpdate.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const VALID_KEY = 'BIulvpvnacETZPcbRM1eBA-EgswBwrkev3pqSELJwHknIjc71adxWApy98SMyOrvgrLDJj2u9-DM0Vw_euvkCuM';

// A `let` (not `const`) so the A -> logout -> B -> logout -> A regression
// test below can simulate different users signing in on the SAME device by
// reassigning it between renderHook() calls -- the mock factory reads the
// CURRENT value on every call, exactly like the real useSession() would
// return a fresh session object per signed-in user.
let session = { userId: 'user-1', role: 'technician' as const };

const mockRepo = {
  isMyPushSubscription: vi.fn(),
  countPushSubscriptions: vi.fn(),
  savePushSubscription: vi.fn(),
  deletePushSubscription: vi.fn(),
  deleteAllPushSubscriptions: vi.fn(),
};

const toast = vi.fn();
let needRefresh = false;
// import.meta.env.VITE_VAPID_PUBLIC_KEY is readonly at the type level
// (see vapidKey.ts) -- tests control the configured key by mocking
// getConfiguredVapidPublicKey directly instead of mutating the real env.
let configuredVapidKey: string | null = VALID_KEY;

vi.mock('../auth/AuthContext', () => ({
  useSession: () => session,
}));
vi.mock('../data/hooks', () => ({
  repo: () => mockRepo,
}));
vi.mock('../components/ui', () => ({
  useToast: () => toast,
}));
vi.mock('../pwa/usePwaUpdate', () => ({
  usePwaUpdate: () => ({ needRefresh, update: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock('./vapidKey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vapidKey')>();
  return { ...actual, getConfiguredVapidPublicKey: () => configuredVapidKey };
});

import { usePushSubscription } from './usePushSubscription';
import { isPushWanted, rememberPushWanted } from './pushDevicePreference';

function createSubscription(overrides: Partial<{ endpoint: string; keys: { p256dh: string; auth: string } | null }> = {}) {
  const endpoint = overrides.endpoint ?? 'https://push.example.com/abc';
  const keys = overrides.keys === undefined ? { p256dh: 'p256dh-key', auth: 'auth-key' } : overrides.keys;
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: keys ?? undefined }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

function installPushGlobals(options: {
  getSubscriptionResult?: ReturnType<typeof createSubscription> | null;
  subscribeResult?: ReturnType<typeof createSubscription>;
  permission?: NotificationPermission;
} = {}) {
  const registration = {
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(options.getSubscriptionResult ?? null),
      subscribe: vi.fn().mockResolvedValue(options.subscribeResult ?? createSubscription()),
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { ready: Promise.resolve(registration) },
    configurable: true,
  });
  (window as unknown as { PushManager: unknown }).PushManager = function () {};
  // Mirrors real browser behavior: Notification.permission is a LIVE value
  // that requestPermission() itself updates -- a static stub here would
  // desync from a later evaluate() re-read (which, correctly, always
  // re-reads the live global rather than trusting a cached decision).
  const notificationMock = {
    permission: options.permission ?? 'granted',
    requestPermission: vi.fn(async () => {
      notificationMock.permission = 'granted';
      return 'granted';
    }),
  };
  (window as unknown as { Notification: unknown }).Notification = notificationMock;
  return registration;
}

function clearPushGlobals() {
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  delete (window as { PushManager?: unknown }).PushManager;
  delete (window as { Notification?: unknown }).Notification;
}

beforeEach(() => {
  needRefresh = false;
  toast.mockClear();
  mockRepo.isMyPushSubscription.mockReset();
  mockRepo.countPushSubscriptions.mockReset();
  mockRepo.savePushSubscription.mockReset();
  mockRepo.deletePushSubscription.mockReset();
  mockRepo.deleteAllPushSubscriptions.mockReset();
  configuredVapidKey = VALID_KEY;
  session = { userId: 'user-1', role: 'technician' as const };
  localStorage.clear();
  Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    configurable: true,
  });
});

afterEach(() => {
  clearPushGlobals();
});

describe('usePushSubscription: state resolution', () => {
  it('A. unsupported browser -> "unsupported"', async () => {
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('unsupported'));
  });

  it('B. iOS-like non-standalone context with no Push APIs -> "install-required"', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      configurable: true,
    });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('install-required'));
  });

  it('C. permission default -> "permission-default"', async () => {
    installPushGlobals({ permission: 'default' });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('permission-default'));
  });

  it('D. permission denied -> "permission-denied"', async () => {
    installPushGlobals({ permission: 'denied' });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('permission-denied'));
  });

  it('E. permission granted but no browser subscription -> "not-subscribed"', async () => {
    installPushGlobals({ permission: 'granted', getSubscriptionResult: null });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('not-subscribed'));
    expect(mockRepo.isMyPushSubscription).not.toHaveBeenCalled();
  });

  it('F. browser subscription exists and belongs to the caller -> "subscribed", with other-device count', async () => {
    installPushGlobals({ permission: 'granted', getSubscriptionResult: createSubscription() });
    mockRepo.isMyPushSubscription.mockResolvedValue(true);
    mockRepo.countPushSubscriptions.mockResolvedValue(3);
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('subscribed'));
    expect(result.current.otherDeviceCount).toBe(2);
    expect(mockRepo.isMyPushSubscription).toHaveBeenCalledWith(session, 'https://push.example.com/abc');
  });

  it('F2. a single device (count=1) reports zero other devices -- no noisy "other devices" text', async () => {
    installPushGlobals({ permission: 'granted', getSubscriptionResult: createSubscription() });
    mockRepo.isMyPushSubscription.mockResolvedValue(true);
    mockRepo.countPushSubscriptions.mockResolvedValue(1);
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('subscribed'));
    expect(result.current.otherDeviceCount).toBe(0);
  });

  it('G. browser subscription exists but belongs to a DIFFERENT AVARIA account -> "not-subscribed" (shared-browser guard)', async () => {
    installPushGlobals({ permission: 'granted', getSubscriptionResult: createSubscription() });
    mockRepo.isMyPushSubscription.mockResolvedValue(false);
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('not-subscribed'));
    expect(mockRepo.countPushSubscriptions).not.toHaveBeenCalled();
  });

  it('R. missing VAPID key fails safely to "configuration-unavailable" (never throws, never fakes support)', async () => {
    configuredVapidKey = null;
    installPushGlobals({ permission: 'granted' });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('configuration-unavailable'));
  });

  it('R2. an invalid (malformed) VAPID key also fails safely to "configuration-unavailable"', async () => {
    configuredVapidKey = 'not-a-real-key';
    installPushGlobals({ permission: 'granted' });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('configuration-unavailable'));
  });

  it('S. never requests Notification permission merely by rendering (no auto-prompt on mount/login)', async () => {
    const registration = installPushGlobals({ permission: 'default' });
    renderHook(() => usePushSubscription());
    await waitFor(() => expect(registration.pushManager.getSubscription).not.toHaveBeenCalled());
    expect((window.Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission).not.toHaveBeenCalled();
  });
});

describe('usePushSubscription: enable()', () => {
  it('H. permission -> subscribe -> save -> subscribed', async () => {
    const subscription = createSubscription();
    const registration = installPushGlobals({ permission: 'default', getSubscriptionResult: null, subscribeResult: subscription });
    mockRepo.savePushSubscription.mockResolvedValue(undefined);
    mockRepo.isMyPushSubscription.mockResolvedValue(true);
    mockRepo.countPushSubscriptions.mockResolvedValue(1);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('permission-default'));

    // enable()'s own pre-subscribe check sees no subscription (the initial
    // config); the fake browser API has no real subscribe() side effect, so
    // the SUBSEQUENT check inside enable()'s closing evaluate() is told the
    // newly-created subscription now exists, matching what a real browser
    // would report after a successful subscribe().
    registration.pushManager.getSubscription.mockResolvedValueOnce(null).mockResolvedValue(subscription);

    await act(async () => {
      await result.current.enable();
    });

    expect(registration.pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(mockRepo.savePushSubscription).toHaveBeenCalledWith(session, subscription.endpoint, {
      p256dh: 'p256dh-key',
      auth: 'auth-key',
    });
    expect(result.current.state).toBe('subscribed');
    expect(toast).toHaveBeenCalledWith('התראות הופעלו במכשיר זה', 'success');
    // T. remembers this user's device Push intent ONLY after the server
    // actually accepted the subscription -- see pushDevicePreference.ts.
    expect(isPushWanted(session.userId)).toBe(true);
  });

  it('I. server save failure after a freshly-created browser subscription rolls the browser subscription back', async () => {
    const subscription = createSubscription();
    installPushGlobals({ permission: 'granted', getSubscriptionResult: null, subscribeResult: subscription });
    mockRepo.savePushSubscription.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('not-subscribed'));

    await act(async () => {
      await result.current.enable();
    });

    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(result.current.state).toBe('error');
    expect(toast).toHaveBeenCalledWith('לא ניתן היה לשמור את ההתראות בשרת. נא לנסות שוב.', 'error');
    // Never remembered as "wanted" before the server actually succeeded.
    expect(isPushWanted(session.userId)).toBe(false);
  });

  it('does not roll back a PRE-EXISTING browser subscription (e.g. shared-browser transfer) when save fails', async () => {
    const subscription = createSubscription();
    installPushGlobals({ permission: 'granted', getSubscriptionResult: subscription });
    mockRepo.isMyPushSubscription.mockResolvedValue(false); // shared-browser: not mine yet
    mockRepo.savePushSubscription.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('not-subscribed'));

    await act(async () => {
      await result.current.enable();
    });

    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    expect(result.current.state).toBe('error');
  });

  it('never re-prompts once permission is denied', async () => {
    installPushGlobals({ permission: 'denied' });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('permission-denied'));

    await act(async () => {
      await result.current.enable();
    });

    expect(
      (window.Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission,
    ).not.toHaveBeenCalled();
    expect(result.current.state).toBe('permission-denied');
  });

  it('refuses to subscribe while a Service Worker update is pending, guiding the user to update first', async () => {
    needRefresh = true;
    const registration = installPushGlobals({ permission: 'granted', getSubscriptionResult: null });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('not-subscribed'));

    await act(async () => {
      await result.current.enable();
    });

    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('יש לעדכן את המערכת לפני הפעלת התראות במכשיר זה.', 'error');
  });

  it('R3. enable() also fails safely to "configuration-unavailable" when the VAPID key is missing', async () => {
    configuredVapidKey = null;
    const registration = installPushGlobals({ permission: 'granted' });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('configuration-unavailable'));

    await act(async () => {
      await result.current.enable();
    });

    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(result.current.state).toBe('configuration-unavailable');
  });
});

describe('usePushSubscription: disable()', () => {
  it('J. deletes server-side before unsubscribing locally, then reports not-subscribed', async () => {
    rememberPushWanted(session.userId);
    const subscription = createSubscription();
    const registration = installPushGlobals({ permission: 'granted', getSubscriptionResult: subscription });
    mockRepo.isMyPushSubscription.mockResolvedValue(true);
    mockRepo.countPushSubscriptions.mockResolvedValue(1);
    mockRepo.deletePushSubscription.mockResolvedValue(undefined);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('subscribed'));

    const callOrder: string[] = [];
    mockRepo.deletePushSubscription.mockImplementation(async () => {
      callOrder.push('server-delete');
    });
    subscription.unsubscribe.mockImplementation(async () => {
      callOrder.push('browser-unsubscribe');
      return true;
    });
    // disable()'s own check still sees the live subscription; the fake
    // browser API has no real unsubscribe() side effect, so the SUBSEQUENT
    // check inside disable()'s closing evaluate() is told it is gone,
    // matching what a real browser would report afterward.
    registration.pushManager.getSubscription.mockResolvedValueOnce(subscription).mockResolvedValue(null);

    await act(async () => {
      await result.current.disable();
    });

    expect(mockRepo.deletePushSubscription).toHaveBeenCalledWith(session, subscription.endpoint);
    expect(callOrder).toEqual(['server-delete', 'browser-unsubscribe']);
    expect(result.current.state).toBe('not-subscribed');
    expect(toast).toHaveBeenCalledWith('התראות כובו במכשיר זה', 'success');
    // U. an explicit disable IS a real preference change -- forget this
    // user's device Push intent so a future login never silently restores it.
    expect(isPushWanted(session.userId)).toBe(false);
  });

  it('a server-side delete failure leaves the browser subscription intact and reports an error, never a false "disabled" -- and never clears the remembered preference either', async () => {
    rememberPushWanted(session.userId);
    const subscription = createSubscription();
    installPushGlobals({ permission: 'granted', getSubscriptionResult: subscription });
    mockRepo.isMyPushSubscription.mockResolvedValue(true);
    mockRepo.countPushSubscriptions.mockResolvedValue(1);
    mockRepo.deletePushSubscription.mockRejectedValue(new Error('server unreachable'));

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('subscribed'));

    await act(async () => {
      await result.current.disable();
    });

    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    expect(result.current.state).toBe('error');
    expect(isPushWanted(session.userId)).toBe(true);
  });
});

describe('usePushSubscription: disconnectAll()', () => {
  it('K. deletes every server-side subscription and locally unsubscribes the current device', async () => {
    rememberPushWanted(session.userId);
    const subscription = createSubscription();
    const registration = installPushGlobals({ permission: 'granted', getSubscriptionResult: subscription });
    mockRepo.isMyPushSubscription.mockResolvedValue(true);
    mockRepo.countPushSubscriptions.mockResolvedValue(3);
    mockRepo.deleteAllPushSubscriptions.mockResolvedValue(undefined);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('subscribed'));

    // disconnectAll()'s own local-cleanup check still sees the live
    // subscription; the closing evaluate() is told it is gone afterward,
    // matching what a real browser would report post-unsubscribe.
    registration.pushManager.getSubscription.mockResolvedValueOnce(subscription).mockResolvedValue(null);

    await act(async () => {
      await result.current.disconnectAll();
    });

    expect(mockRepo.deleteAllPushSubscriptions).toHaveBeenCalledWith(session);
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(result.current.state).toBe('not-subscribed');
    expect(toast).toHaveBeenCalledWith('כל המכשירים נותקו', 'success');
    // "נתק את כל המכשירים" also clears the CURRENT device/user's remembered
    // preference -- an explicit disconnect must not be silently undone by
    // auto-restore on the next login.
    expect(isPushWanted(session.userId)).toBe(false);
  });

  it('a server-side failure surfaces an error and never claims success, and leaves the remembered preference untouched', async () => {
    rememberPushWanted(session.userId);
    installPushGlobals({ permission: 'granted', getSubscriptionResult: createSubscription() });
    mockRepo.isMyPushSubscription.mockResolvedValue(true);
    mockRepo.countPushSubscriptions.mockResolvedValue(1);
    mockRepo.deleteAllPushSubscriptions.mockRejectedValue(new Error('server unreachable'));

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('subscribed'));

    await act(async () => {
      await result.current.disconnectAll();
    });

    expect(result.current.state).toBe('error');
    expect(toast).not.toHaveBeenCalledWith('כל המכשירים נותקו', 'success');
    expect(isPushWanted(session.userId)).toBe(true);
  });
});

describe('usePushSubscription: silent auto-restore on login (per-user, per-device preference)', () => {
  it('V. restores Push automatically when this user previously enabled it on this device and permission is already granted -- no prompt, no toast', async () => {
    rememberPushWanted(session.userId);
    const subscription = createSubscription();
    const registration = installPushGlobals({ permission: 'granted', getSubscriptionResult: null, subscribeResult: subscription });
    mockRepo.savePushSubscription.mockResolvedValue(undefined);
    mockRepo.isMyPushSubscription.mockResolvedValue(true);
    mockRepo.countPushSubscriptions.mockResolvedValue(1);
    // Two calls see no browser subscription yet (mirrors a device that
    // logged out -- and therefore unsubscribed -- earlier): the initial
    // mount evaluate(), then auto-restore's own pre-subscribe check. Once
    // auto-restore's subscribe() call actually creates one, the closing
    // evaluate() after it succeeds sees it, matching a real browser.
    registration.pushManager.getSubscription
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(subscription);

    const { result } = renderHook(() => usePushSubscription());

    await waitFor(() => expect(result.current.state).toBe('subscribed'));
    expect(registration.pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(mockRepo.savePushSubscription).toHaveBeenCalledWith(session, subscription.endpoint, {
      p256dh: 'p256dh-key',
      auth: 'auth-key',
    });
    expect(
      (window.Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission,
    ).not.toHaveBeenCalled();
    // No toast for a background restore the user did not initiate.
    expect(toast).not.toHaveBeenCalled();
  });

  it('W. never restores when this user never enabled Push on this device', async () => {
    const registration = installPushGlobals({ permission: 'granted', getSubscriptionResult: null });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('not-subscribed'));

    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(mockRepo.savePushSubscription).not.toHaveBeenCalled();
  });

  it('X. never restores (and never prompts) when permission is "default", even with a remembered preference', async () => {
    rememberPushWanted(session.userId);
    installPushGlobals({ permission: 'default' });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('permission-default'));

    expect(
      (window.Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission,
    ).not.toHaveBeenCalled();
    expect(mockRepo.savePushSubscription).not.toHaveBeenCalled();
  });

  it('Y. never restores when permission is "denied", even with a remembered preference', async () => {
    rememberPushWanted(session.userId);
    installPushGlobals({ permission: 'denied' });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('permission-denied'));

    expect(mockRepo.savePushSubscription).not.toHaveBeenCalled();
  });

  it('Z. a background restore failure (server save error) never surfaces as an error state or a toast, and never breaks the hook', async () => {
    rememberPushWanted(session.userId);
    const subscription = createSubscription();
    installPushGlobals({ permission: 'granted', getSubscriptionResult: null, subscribeResult: subscription });
    mockRepo.savePushSubscription.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('not-subscribed'));

    // Give the background retry microtask queue a tick to run to completion.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state).toBe('not-subscribed');
    expect(toast).not.toHaveBeenCalled();
    // The freshly-created browser subscription is rolled back, same as a
    // manual enable() would do on a save failure.
    expect(subscription.unsubscribe).toHaveBeenCalled();
  });

  it('AA. A -> logout -> B -> logout -> A: Push auto-restores only when A returns, never for B', async () => {
    // --- User A explicitly enables Push on this device ---
    session = { userId: 'user-a', role: 'technician' };
    const subscriptionA = createSubscription({ endpoint: 'https://push.example.com/a' });
    let registration = installPushGlobals({ permission: 'granted', getSubscriptionResult: null, subscribeResult: subscriptionA });
    mockRepo.savePushSubscription.mockResolvedValue(undefined);
    mockRepo.isMyPushSubscription.mockResolvedValue(true);
    mockRepo.countPushSubscriptions.mockResolvedValue(1);

    const renderA1 = renderHook(() => usePushSubscription());
    await waitFor(() => expect(renderA1.result.current.state).toBe('not-subscribed'));
    // enable()'s own pre-subscribe check sees no subscription (matching the
    // state just confirmed above); the closing evaluate() afterward is told
    // the newly-created subscription now exists, as a real browser would
    // report post-subscribe().
    registration.pushManager.getSubscription.mockResolvedValueOnce(null).mockResolvedValue(subscriptionA);
    await act(async () => {
      await renderA1.result.current.enable();
    });
    await waitFor(() => expect(renderA1.result.current.state).toBe('subscribed'));
    expect(isPushWanted('user-a')).toBe(true);
    // Logout detaches the subscription (see pushLogoutCleanup.ts) but never
    // touches the remembered preference -- simulate that here by clearing
    // the browser's own PushSubscription, exactly like a real unsubscribe().
    renderA1.unmount();
    clearPushGlobals();

    // --- User B logs in on the SAME device; browser has no subscription
    //     left (A's was detached at logout) and B never opted in before ---
    session = { userId: 'user-b', role: 'technician' };
    registration = installPushGlobals({ permission: 'granted', getSubscriptionResult: null });
    mockRepo.savePushSubscription.mockClear();

    const renderB = renderHook(() => usePushSubscription());
    await waitFor(() => expect(renderB.result.current.state).toBe('not-subscribed'));
    expect(mockRepo.savePushSubscription).not.toHaveBeenCalled();
    expect(isPushWanted('user-b')).toBe(false);
    renderB.unmount();
    clearPushGlobals();

    // --- User A logs back in: remembered preference + granted permission
    //     silently restores Push, with no button press ---
    session = { userId: 'user-a', role: 'technician' };
    const subscriptionA2 = createSubscription({ endpoint: 'https://push.example.com/a2' });
    registration = installPushGlobals({ permission: 'granted', getSubscriptionResult: null, subscribeResult: subscriptionA2 });
    // Two calls see nothing: the initial mount evaluate(), then
    // auto-restore's own pre-subscribe check -- then the newly-created
    // subscription once auto-restore's subscribe() call succeeds.
    registration.pushManager.getSubscription
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(subscriptionA2);
    mockRepo.savePushSubscription.mockClear();
    mockRepo.savePushSubscription.mockResolvedValue(undefined);

    const renderA2 = renderHook(() => usePushSubscription());
    await waitFor(() => expect(renderA2.result.current.state).toBe('subscribed'));
    expect(mockRepo.savePushSubscription).toHaveBeenCalledWith(
      { userId: 'user-a', role: 'technician' },
      subscriptionA2.endpoint,
      { p256dh: 'p256dh-key', auth: 'auth-key' },
    );
  });
});

describe('usePushSubscription: auto-restore logout race safety', () => {
  it('AB. logout mid-flight: a subscription saved AFTER the hook has already unmounted is immediately detached again, never left live', async () => {
    rememberPushWanted(session.userId);
    const subscription = createSubscription();
    installPushGlobals({ permission: 'granted', getSubscriptionResult: null, subscribeResult: subscription });
    mockRepo.deletePushSubscription.mockResolvedValue(undefined);

    // Freeze the server save mid-flight so the test can unmount (simulating
    // an explicit logout tearing down the whole authenticated tree) BEFORE
    // the network round trip that would otherwise complete the restore.
    let resolveSave!: () => void;
    mockRepo.savePushSubscription.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    const { result, unmount } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('not-subscribed'));
    // Auto-restore has started and is now blocked inside the (deferred) save.
    await waitFor(() => expect(mockRepo.savePushSubscription).toHaveBeenCalledTimes(1));

    // Explicit logout: the authenticated tree -- and with it this hook
    // instance -- unmounts, exactly as AuthContext's status flip to
    // 'signed_out' does today. runLogoutPushCleanup (untouched by this fix)
    // would see NO browser subscription yet at this exact moment, since
    // auto-restore has not created/saved one -- that is precisely the race.
    unmount();

    // The delayed save now finally resolves, AFTER logout already happened.
    resolveSave();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The subscription must not survive the logout that happened while it
    // was still being created: a best-effort server-side detach was
    // attempted with the same (captured) session...
    expect(mockRepo.deletePushSubscription).toHaveBeenCalledWith(session, subscription.endpoint);
    // ...and the browser endpoint itself was torn down regardless, so no
    // future push can ever reach it even if the server-side delete above
    // had failed (e.g. because the JWT that authorized it is already gone).
    expect(subscription.unsubscribe).toHaveBeenCalled();
  });

  it('AC. logout mid-flight never blocks on a hung save -- the compensating cleanup is itself best-effort', async () => {
    rememberPushWanted(session.userId);
    const subscription = createSubscription();
    installPushGlobals({ permission: 'granted', getSubscriptionResult: null, subscribeResult: subscription });
    mockRepo.savePushSubscription.mockImplementation(() => new Promise<void>(() => {})); // never resolves

    const { result, unmount } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('not-subscribed'));
    await waitFor(() => expect(mockRepo.savePushSubscription).toHaveBeenCalledTimes(1));

    // Unmounting (logout) must complete immediately and never throw, even
    // though the auto-restore chain it is racing against is stuck forever.
    expect(() => unmount()).not.toThrow();
  });

  it('AD. after a logout-race rollback, the SAME user logging back in still restores Push normally (the rollback does not poison future restores)', async () => {
    rememberPushWanted(session.userId);
    const staleSubscription = createSubscription({ endpoint: 'https://push.example.com/stale' });
    installPushGlobals({ permission: 'granted', getSubscriptionResult: null, subscribeResult: staleSubscription });
    mockRepo.deletePushSubscription.mockResolvedValue(undefined);

    let resolveStaleSave!: () => void;
    mockRepo.savePushSubscription.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStaleSave = resolve;
        }),
    );

    const render1 = renderHook(() => usePushSubscription());
    await waitFor(() => expect(render1.result.current.state).toBe('not-subscribed'));
    await waitFor(() => expect(mockRepo.savePushSubscription).toHaveBeenCalledTimes(1));

    render1.unmount();
    resolveStaleSave();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(staleSubscription.unsubscribe).toHaveBeenCalled();

    // The SAME user opens AVARIA again on this device -- the browser has no
    // subscription left (the rollback above unsubscribed it), and the
    // remembered preference is still true, so auto-restore must run again
    // and succeed normally.
    const freshSubscription = createSubscription({ endpoint: 'https://push.example.com/fresh' });
    const registration2 = installPushGlobals({ permission: 'granted', getSubscriptionResult: null, subscribeResult: freshSubscription });
    registration2.pushManager.getSubscription.mockResolvedValueOnce(null).mockResolvedValue(freshSubscription);
    mockRepo.isMyPushSubscription.mockResolvedValue(true);
    mockRepo.countPushSubscriptions.mockResolvedValue(1);
    mockRepo.savePushSubscription.mockReset();
    mockRepo.savePushSubscription.mockResolvedValue(undefined);

    const render2 = renderHook(() => usePushSubscription());
    await waitFor(() => expect(render2.result.current.state).toBe('subscribed'));
    expect(mockRepo.savePushSubscription).toHaveBeenCalledWith(session, freshSubscription.endpoint, {
      p256dh: 'p256dh-key',
      auth: 'auth-key',
    });
  });

  it('AE. a different user logging in after a logout-race rollback never inherits the rolled-back subscription', async () => {
    session = { userId: 'user-a', role: 'technician' };
    rememberPushWanted('user-a');
    const staleSubscription = createSubscription({ endpoint: 'https://push.example.com/stale' });
    installPushGlobals({ permission: 'granted', getSubscriptionResult: null, subscribeResult: staleSubscription });
    mockRepo.deletePushSubscription.mockResolvedValue(undefined);

    let resolveStaleSave!: () => void;
    mockRepo.savePushSubscription.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStaleSave = resolve;
        }),
    );

    const renderA = renderHook(() => usePushSubscription());
    await waitFor(() => expect(renderA.result.current.state).toBe('not-subscribed'));
    await waitFor(() => expect(mockRepo.savePushSubscription).toHaveBeenCalledTimes(1));

    renderA.unmount();
    resolveStaleSave();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(staleSubscription.unsubscribe).toHaveBeenCalled();

    // User B logs in on the same device -- the browser has no subscription
    // (unsubscribed by the rollback above), and B never opted in.
    session = { userId: 'user-b', role: 'technician' };
    installPushGlobals({ permission: 'granted', getSubscriptionResult: null });
    mockRepo.savePushSubscription.mockClear();

    const renderB = renderHook(() => usePushSubscription());
    await waitFor(() => expect(renderB.result.current.state).toBe('not-subscribed'));
    expect(mockRepo.savePushSubscription).not.toHaveBeenCalled();
  });

  it('AF. an explicit enable() while auto-restore is still mid-flight shares the SAME subscribe/save call instead of racing a duplicate one', async () => {
    rememberPushWanted(session.userId);
    const subscription = createSubscription();
    const registration = installPushGlobals({ permission: 'granted', getSubscriptionResult: null, subscribeResult: subscription });
    mockRepo.isMyPushSubscription.mockResolvedValue(true);
    mockRepo.countPushSubscriptions.mockResolvedValue(1);

    let resolveSave!: () => void;
    mockRepo.savePushSubscription.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('not-subscribed'));
    // Auto-restore has already created the browser subscription and is
    // blocked inside the (deferred) server save. From here on, the browser
    // reports the newly-created subscription as present -- matching a real
    // browser post-subscribe() -- so the closing evaluate() (once the save
    // finally resolves) correctly lands on 'subscribed' instead of spuriously
    // re-triggering ANOTHER auto-restore attempt.
    await waitFor(() => expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1));
    registration.pushManager.getSubscription.mockResolvedValue(subscription);
    await waitFor(() => expect(mockRepo.savePushSubscription).toHaveBeenCalledTimes(1));

    // The user opens Push settings and presses enable() while that restore
    // is still pending -- this must NOT start a second, independent
    // subscribe()/save call.
    let enableResolved = false;
    let enablePromise!: Promise<void>;
    await act(async () => {
      enablePromise = result.current.enable().then(() => {
        enableResolved = true;
      });
      // Give enable() a chance to run its synchronous prelude and reach
      // runSubscribeAndPersist -- it must find (and reuse) the existing
      // in-flight operation rather than starting its own.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(enableResolved).toBe(false); // still waiting on the SAME save
    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(mockRepo.savePushSubscription).toHaveBeenCalledTimes(1);

    resolveSave();
    await act(async () => {
      await enablePromise;
    });

    // Only ONE underlying browser subscribe() / server save call was ever
    // made, even though two independent triggers (auto-restore + enable())
    // both wanted to subscribe around the same time.
    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(mockRepo.savePushSubscription).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('subscribed');
  });
});

describe('usePushSubscription: pre-existing subscription backfill (pre-release compatibility)', () => {
  it('AG. an existing, server-owned subscription from before this preference existed is backfilled into isPushWanted on the very first evaluate()', async () => {
    // No rememberPushWanted() call anywhere -- this simulates a user who
    // enabled Push under the OLD version, before this local preference
    // existed at all.
    const subscription = createSubscription();
    installPushGlobals({ permission: 'granted', getSubscriptionResult: subscription });
    mockRepo.isMyPushSubscription.mockResolvedValue(true);
    mockRepo.countPushSubscriptions.mockResolvedValue(1);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('subscribed'));

    expect(isPushWanted(session.userId)).toBe(true);
  });

  it('AH. a browser subscription that does NOT belong to the current user is never backfilled', async () => {
    const subscription = createSubscription();
    installPushGlobals({ permission: 'granted', getSubscriptionResult: subscription });
    mockRepo.isMyPushSubscription.mockResolvedValue(false); // shared-browser / foreign endpoint

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('not-subscribed'));

    expect(isPushWanted(session.userId)).toBe(false);
  });

  it('AI. Notification permission being granted, by itself, never backfills anything', async () => {
    installPushGlobals({ permission: 'granted', getSubscriptionResult: null });

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('not-subscribed'));

    // No browser subscription at all -- the ownership check is never even
    // reached, so there is nothing that could justify a backfill.
    expect(mockRepo.isMyPushSubscription).not.toHaveBeenCalled();
    expect(isPushWanted(session.userId)).toBe(false);
  });

  it('AJ. after the backfill, a later logout -> login cycle restores Push automatically with no manual enable() click', async () => {
    // Phase 1: a pre-existing subscribed user, with no local preference yet
    // -- the initial evaluate() backfills it.
    const staleSubscription = createSubscription({ endpoint: 'https://push.example.com/old' });
    installPushGlobals({ permission: 'granted', getSubscriptionResult: staleSubscription });
    mockRepo.isMyPushSubscription.mockResolvedValue(true);
    mockRepo.countPushSubscriptions.mockResolvedValue(1);

    const render1 = renderHook(() => usePushSubscription());
    await waitFor(() => expect(render1.result.current.state).toBe('subscribed'));
    expect(isPushWanted(session.userId)).toBe(true);

    // Logout detaches the subscription (browser now has none) but -- as
    // established earlier -- leaves the (just-backfilled) preference
    // intact. Simulate the post-logout device state directly.
    render1.unmount();
    clearPushGlobals();

    // Phase 2: the SAME user opens AVARIA again. No browser subscription
    // exists, but the backfilled preference is still there, so auto-restore
    // must recreate Push on its own -- enable() is never called here.
    const freshSubscription = createSubscription({ endpoint: 'https://push.example.com/fresh' });
    const registration2 = installPushGlobals({ permission: 'granted', getSubscriptionResult: null, subscribeResult: freshSubscription });
    registration2.pushManager.getSubscription.mockResolvedValueOnce(null).mockResolvedValue(freshSubscription);
    mockRepo.savePushSubscription.mockResolvedValue(undefined);

    const render2 = renderHook(() => usePushSubscription());
    await waitFor(() => expect(render2.result.current.state).toBe('subscribed'));
    expect(mockRepo.savePushSubscription).toHaveBeenCalledWith(session, freshSubscription.endpoint, {
      p256dh: 'p256dh-key',
      auth: 'auth-key',
    });
  });

  it('AK. an explicit disable() still clears the preference, and it is not immediately re-created by the backfill logic', async () => {
    const subscription = createSubscription();
    const registration = installPushGlobals({ permission: 'granted', getSubscriptionResult: subscription });
    mockRepo.isMyPushSubscription.mockResolvedValue(true);
    mockRepo.countPushSubscriptions.mockResolvedValue(1);
    mockRepo.deletePushSubscription.mockResolvedValue(undefined);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('subscribed'));
    // Backfilled on mount, exactly like AG above.
    expect(isPushWanted(session.userId)).toBe(true);

    registration.pushManager.getSubscription.mockResolvedValueOnce(subscription).mockResolvedValue(null);
    await act(async () => {
      await result.current.disable();
    });
    expect(result.current.state).toBe('not-subscribed');
    expect(isPushWanted(session.userId)).toBe(false);

    // A later evaluate() (e.g. the next time this device opens AVARIA) must
    // not resurrect the preference: the browser subscription is gone, so
    // the ownership check that gates the backfill is never even reached.
    mockRepo.isMyPushSubscription.mockClear();
    const render2 = renderHook(() => usePushSubscription());
    await waitFor(() => expect(render2.result.current.state).toBe('not-subscribed'));
    expect(mockRepo.isMyPushSubscription).not.toHaveBeenCalled();
    expect(isPushWanted(session.userId)).toBe(false);
  });

  it('AL. an explicit disconnectAll() still clears the preference, and it is not immediately re-created by the backfill logic', async () => {
    const subscription = createSubscription();
    const registration = installPushGlobals({ permission: 'granted', getSubscriptionResult: subscription });
    mockRepo.isMyPushSubscription.mockResolvedValue(true);
    mockRepo.countPushSubscriptions.mockResolvedValue(1);
    mockRepo.deleteAllPushSubscriptions.mockResolvedValue(undefined);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.state).toBe('subscribed'));
    expect(isPushWanted(session.userId)).toBe(true);

    registration.pushManager.getSubscription.mockResolvedValueOnce(subscription).mockResolvedValue(null);
    await act(async () => {
      await result.current.disconnectAll();
    });
    expect(result.current.state).toBe('not-subscribed');
    expect(isPushWanted(session.userId)).toBe(false);

    mockRepo.isMyPushSubscription.mockClear();
    const render2 = renderHook(() => usePushSubscription());
    await waitFor(() => expect(render2.result.current.state).toBe('not-subscribed'));
    expect(mockRepo.isMyPushSubscription).not.toHaveBeenCalled();
    expect(isPushWanted(session.userId)).toBe(false);
  });
});
