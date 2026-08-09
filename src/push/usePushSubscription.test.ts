// usePushSubscription: the client Push state machine. Browser Push APIs
// (Notification, navigator.serviceWorker, PushManager) do not exist in
// jsdom, so every test installs its own minimal stand-ins -- see
// installPushGlobals below -- while the repository/toast/auth/PWA-update
// seams are mocked at the module boundary, matching this codebase's existing
// hook-test convention (see src/pwa/usePwaUpdate.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const VALID_KEY = 'BIulvpvnacETZPcbRM1eBA-EgswBwrkev3pqSELJwHknIjc71adxWApy98SMyOrvgrLDJj2u9-DM0Vw_euvkCuM';

const session = { userId: 'user-1', role: 'technician' as const };

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
  });

  it('a server-side delete failure leaves the browser subscription intact and reports an error, never a false "disabled"', async () => {
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
  });
});

describe('usePushSubscription: disconnectAll()', () => {
  it('K. deletes every server-side subscription and locally unsubscribes the current device', async () => {
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
  });

  it('a server-side failure surfaces an error and never claims success', async () => {
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
  });
});
