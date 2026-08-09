// Centralized, pure feature-detection for Web Push. Every capability check
// UI components or usePushSubscription need lives here -- nothing in this
// codebase should call `'serviceWorker' in navigator` or read
// `Notification.permission` directly outside this module and
// usePushSubscription's own browser-API calls (getSubscription/subscribe/
// unsubscribe), which cannot be expressed as a pure synchronous check.
//
// Feature detection is the MAIN gate everywhere in this module. isLikelyIOS
// is the one deliberate exception: it exists only to decide between the
// 'unsupported' and 'install-required' UI states when feature detection has
// already failed, matching iOS Safari's real constraint (Push is only
// exposed to an installed Home Screen web app) -- it never gates anything by
// itself.

export function supportsServiceWorker(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

export function supportsPushManager(): boolean {
  return typeof window !== 'undefined' && 'PushManager' in window;
}

export function supportsNotificationApi(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** The full feature-detection gate: all three Web Push building blocks. */
export function isPushApiSupported(): boolean {
  return supportsServiceWorker() && supportsPushManager() && supportsNotificationApi();
}

/** Current permission, or 'unsupported' when the Notification API itself
 *  doesn't exist (reading Notification.permission would throw otherwise). */
export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (!supportsNotificationApi()) return 'unsupported';
  return Notification.permission;
}

/** True when AVARIA is running installed/standalone (Home-Screen app on iOS,
 *  or an installed PWA elsewhere) -- checked via the standard display-mode
 *  media query plus iOS Safari's own (non-standard) navigator.standalone
 *  flag, since iOS never reports 'standalone' through the media query. */
export function isStandaloneDisplayMode(): boolean {
  if (typeof window === 'undefined') return false;
  const navigatorWithIosFlag = navigator as Navigator & { standalone?: boolean };
  if (navigatorWithIosFlag.standalone === true) return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
}

/**
 * Narrow, best-effort iOS/iPadOS signal used ONLY to choose the
 * 'install-required' message over a plain 'unsupported' one -- never as the
 * primary support gate (see module comment). iPadOS 13+ reports a desktop
 * Safari user agent, so touch support + the classic Mac platform string is
 * checked too, the same heuristic Apple's own documentation recommends for
 * distinguishing iPadOS from a real Mac.
 */
export function isLikelyIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}
