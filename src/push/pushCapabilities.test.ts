import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getNotificationPermission,
  isLikelyIOS,
  isPushApiSupported,
  isStandaloneDisplayMode,
  supportsNotificationApi,
  supportsPushManager,
  supportsServiceWorker,
} from './pushCapabilities';

describe('pushCapabilities: feature detection', () => {
  const originalUserAgent = navigator.userAgent;
  const originalPlatform = navigator.platform;
  const originalMaxTouchPoints = navigator.maxTouchPoints;

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { value: originalUserAgent, configurable: true });
    Object.defineProperty(navigator, 'platform', { value: originalPlatform, configurable: true });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: originalMaxTouchPoints, configurable: true });
    delete (window as { PushManager?: unknown }).PushManager;
    delete (window as { Notification?: unknown }).Notification;
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    delete (navigator as { standalone?: boolean }).standalone;
  });

  it('jsdom (no real Push APIs) reports every building block unsupported', () => {
    expect(supportsServiceWorker()).toBe(false);
    expect(supportsPushManager()).toBe(false);
    expect(supportsNotificationApi()).toBe(false);
    expect(isPushApiSupported()).toBe(false);
  });

  it('is supported only when all three building blocks are present', () => {
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
    (window as unknown as { PushManager: unknown }).PushManager = function () {};
    expect(isPushApiSupported()).toBe(false); // Notification still missing

    (window as unknown as { Notification: unknown }).Notification = { permission: 'default' };
    expect(isPushApiSupported()).toBe(true);
  });

  it('getNotificationPermission reports "unsupported" when the Notification API does not exist', () => {
    expect(getNotificationPermission()).toBe('unsupported');
  });

  it('getNotificationPermission mirrors Notification.permission when present', () => {
    (window as unknown as { Notification: unknown }).Notification = { permission: 'granted' };
    expect(getNotificationPermission()).toBe('granted');
  });

  it('isStandaloneDisplayMode is false by default in jsdom', () => {
    expect(isStandaloneDisplayMode()).toBe(false);
  });

  it('isStandaloneDisplayMode reads the iOS navigator.standalone flag', () => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    expect(isStandaloneDisplayMode()).toBe(true);
  });

  it('isStandaloneDisplayMode reads the display-mode media query', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(display-mode: standalone)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    expect(isStandaloneDisplayMode()).toBe(true);
    window.matchMedia = originalMatchMedia;
  });

  it('isLikelyIOS detects an iPhone/iPad user agent', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      configurable: true,
    });
    expect(isLikelyIOS()).toBe(true);
  });

  it('isLikelyIOS detects iPadOS reporting a desktop Safari user agent via touch + platform', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      configurable: true,
    });
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
    expect(isLikelyIOS()).toBe(true);
  });

  it('isLikelyIOS is false for a real desktop Mac (no touch points) or an unrelated browser', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      configurable: true,
    });
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
    expect(isLikelyIOS()).toBe(false);

    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      configurable: true,
    });
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    expect(isLikelyIOS()).toBe(false);
  });
});

describe('pushCapabilities: never used as the primary gate by UA sniffing alone', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      configurable: true,
    });
  });

  it('a browser that LOOKS like iOS but genuinely exposes the Push APIs is still reported supported', () => {
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
    (window as unknown as { PushManager: unknown }).PushManager = function () {};
    (window as unknown as { Notification: unknown }).Notification = { permission: 'default' };
    expect(isPushApiSupported()).toBe(true);
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    delete (window as { PushManager?: unknown }).PushManager;
    delete (window as { Notification?: unknown }).Notification;
  });
});
