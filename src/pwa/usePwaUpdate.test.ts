import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const setNeedRefresh = vi.fn();
const updateServiceWorker = vi.fn();
let needRefresh = false;

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [false, vi.fn()],
    updateServiceWorker,
  }),
}));

import { usePwaUpdate } from './usePwaUpdate';

describe('usePwaUpdate', () => {
  beforeEach(() => {
    needRefresh = false;
    setNeedRefresh.mockClear();
    updateServiceWorker.mockClear();
  });

  it('mirrors needRefresh from the underlying registration', () => {
    needRefresh = true;
    const { result } = renderHook(() => usePwaUpdate());
    expect(result.current.needRefresh).toBe(true);
  });

  it('update() invokes the Service Worker update flow', () => {
    const { result } = renderHook(() => usePwaUpdate());
    result.current.update();
    // `true` is the "take control now" argument -- the page only reloads as
    // a direct consequence of this call, once the new worker activates.
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it('dismiss() clears needRefresh without touching the Service Worker', () => {
    const { result } = renderHook(() => usePwaUpdate());
    result.current.dismiss();
    expect(setNeedRefresh).toHaveBeenCalledWith(false);
    expect(updateServiceWorker).not.toHaveBeenCalled();
  });
});
