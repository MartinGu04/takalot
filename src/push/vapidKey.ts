// Web Push application-server key (VAPID) handling for the client only.
// Reads the OPTIONAL public key from VITE_VAPID_PUBLIC_KEY and converts it to
// the raw bytes PushManager.subscribe() requires. Never reads, generates, or
// stores a private key -- that belongs to the Phase 5 server-side dispatcher
// only, and must never exist in a VITE_* variable (ships to every browser).
//
// A missing or malformed key is NOT an application error: Phase 4 ships
// without a real hosted keypair (Phase 5's job), so this resolves to null/
// false and the caller (usePushSubscription) surfaces the calm
// 'configuration-unavailable' state instead of crashing or pretending a
// subscription is possible.

/** A raw EC P-256 public point is exactly 65 bytes (0x04 + 32-byte X + 32-byte
 *  Y) -- true for every real VAPID public key regardless of vendor. */
const RAW_EC_POINT_LENGTH = 65;
const UNCOMPRESSED_POINT_PREFIX = 0x04;

/**
 * Trimmed configured key, or null when unset/blank. Does not validate shape
 * -- see isValidVapidPublicKey for that. `env` defaults to the real
 * import.meta.env (readonly at the type level, matching appMode.ts's own
 * contract) and exists as a parameter purely as a test seam -- unit tests
 * pass an explicit object instead of mutating the real one.
 */
export function getConfiguredVapidPublicKey(
  env: Pick<ImportMetaEnv, 'VITE_VAPID_PUBLIC_KEY'> = import.meta.env,
): string | null {
  const trimmed = env.VITE_VAPID_PUBLIC_KEY?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Converts a base64url-encoded string (the format every Web Push VAPID key
 * is published in) to the raw Uint8Array PushManager.subscribe() requires
 * for applicationServerKey. Throws on input that cannot be decoded as
 * base64 -- callers must validate with isValidVapidPublicKey first if they
 * need a non-throwing path.
 */
export function urlBase64ToUint8Array(base64UrlString: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64UrlString.length % 4)) % 4);
  const base64 = (base64UrlString + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * True only for a string that decodes to a plausible raw VAPID public key
 * (65-byte uncompressed EC point starting with 0x04). Never throws --
 * a malformed/misconfigured value (wrong key pasted, private key pasted by
 * mistake, truncated value) fails this check rather than reaching
 * PushManager.subscribe() and failing there with an opaque browser error.
 */
export function isValidVapidPublicKey(key: string | null | undefined): boolean {
  if (!key) return false;
  try {
    const bytes = urlBase64ToUint8Array(key);
    return bytes.length === RAW_EC_POINT_LENGTH && bytes[0] === UNCOMPRESSED_POINT_PREFIX;
  } catch {
    return false;
  }
}
