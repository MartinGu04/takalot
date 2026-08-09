import { afterEach, describe, expect, it, vi } from 'vitest';
import { detachCurrentDevicePush, runLogoutPushCleanup } from './pushLogoutCleanup';
import type { Repository, Session } from '../data/repository';

const session: Session = { userId: 'user-1', role: 'technician' };

function subscription(endpoint = 'https://push.example.com/abc') {
  return { endpoint, unsubscribe: vi.fn().mockResolvedValue(true) };
}

describe('detachCurrentDevicePush', () => {
  it('M. normal successful cleanup: deletes server-side, then unsubscribes locally', async () => {
    const sub = subscription();
    const deleteSubscription = vi.fn().mockResolvedValue(undefined);
    const callOrder: string[] = [];
    deleteSubscription.mockImplementation(async () => {
      callOrder.push('server-delete');
    });
    sub.unsubscribe.mockImplementation(async () => {
      callOrder.push('browser-unsubscribe');
      return true;
    });

    await detachCurrentDevicePush({
      getRegistration: async () => ({ pushManager: { getSubscription: async () => sub } }),
      deleteSubscription,
    });

    expect(callOrder).toEqual(['server-delete', 'browser-unsubscribe']);
    expect(deleteSubscription).toHaveBeenCalledWith(sub.endpoint);
  });

  it('is a safe no-op when no registration exists', async () => {
    const deleteSubscription = vi.fn();
    await expect(
      detachCurrentDevicePush({ getRegistration: async () => null, deleteSubscription }),
    ).resolves.toBeUndefined();
    expect(deleteSubscription).not.toHaveBeenCalled();
  });

  it('is a safe no-op when the registration has no subscription', async () => {
    const deleteSubscription = vi.fn();
    await detachCurrentDevicePush({
      getRegistration: async () => ({ pushManager: { getSubscription: async () => null } }),
      deleteSubscription,
    });
    expect(deleteSubscription).not.toHaveBeenCalled();
  });

  it('N. a browser unsubscribe failure never throws and never blocks completion', async () => {
    const sub = subscription();
    sub.unsubscribe.mockRejectedValue(new Error('unsubscribe failed'));
    const deleteSubscription = vi.fn().mockResolvedValue(undefined);

    await expect(
      detachCurrentDevicePush({
        getRegistration: async () => ({ pushManager: { getSubscription: async () => sub } }),
        deleteSubscription,
      }),
    ).resolves.toBeUndefined();
    expect(deleteSubscription).toHaveBeenCalled();
  });

  it('O. a server-side delete failure never throws, and the browser unsubscribe still runs (harmless once the server no longer owns the endpoint)', async () => {
    const sub = subscription();
    const deleteSubscription = vi.fn().mockRejectedValue(new Error('server unreachable'));

    await expect(
      detachCurrentDevicePush({
        getRegistration: async () => ({ pushManager: { getSubscription: async () => sub } }),
        deleteSubscription,
      }),
    ).resolves.toBeUndefined();
    expect(sub.unsubscribe).toHaveBeenCalled();
  });

  it('P. a hanging cleanup resolves once the bounded timeout elapses, never blocking indefinitely', async () => {
    const deleteSubscription = vi.fn().mockResolvedValue(undefined);
    const hangingGetRegistration = () => new Promise<never>(() => {}); // never resolves

    const start = Date.now();
    await detachCurrentDevicePush({
      getRegistration: hangingGetRegistration,
      deleteSubscription,
      timeoutMs: 30,
    });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('P2. an eventual late rejection from a timed-out attempt never surfaces as an unhandled rejection', async () => {
    let rejectLate!: (err: Error) => void;
    const lateRejectingRegistration = new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    });
    const deleteSubscription = vi.fn();

    await detachCurrentDevicePush({
      getRegistration: () => lateRejectingRegistration,
      deleteSubscription,
      timeoutMs: 10,
    });
    // Reject well after the bounded call already resolved via the timeout --
    // this must be swallowed, not thrown as an unhandled rejection.
    rejectLate(new Error('late failure, arriving after the bound'));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

describe('runLogoutPushCleanup: real-browser wiring', () => {
  afterEach(() => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });

  it('resolves without touching the repository when the browser has no Service Worker support', async () => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    const repo = { deletePushSubscription: vi.fn() } as unknown as Repository;
    await expect(runLogoutPushCleanup(repo, session)).resolves.toBeUndefined();
    expect(repo.deletePushSubscription).not.toHaveBeenCalled();
  });

  it('calls Repository.deletePushSubscription with the caller session and the live endpoint', async () => {
    const sub = subscription('https://push.example.com/real-device');
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: { getSubscription: vi.fn().mockResolvedValue(sub) },
        }),
      },
      configurable: true,
    });
    const repo = { deletePushSubscription: vi.fn().mockResolvedValue(undefined) } as unknown as Repository;

    await runLogoutPushCleanup(repo, session);

    expect(repo.deletePushSubscription).toHaveBeenCalledWith(session, sub.endpoint);
    expect(sub.unsubscribe).toHaveBeenCalled();
  });
});
