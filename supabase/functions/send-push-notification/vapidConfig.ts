// VAPID runtime configuration resolution for send-push-notification. Reads
// ONLY from this function's own environment variables -- never from the
// request body/headers, never from VITE_* (a client-side variable ships to
// every browser), never hardcoded. An absent/invalid setting resolves to
// `null` rather than throwing, so the caller fails safely (no provider
// call attempted, a logged server-side configuration error) instead of
// crashing the whole invocation. Key material is never included in the
// return value's error path -- there is none; resolveVapidConfig only ever
// returns the full valid config or null, nothing partial.
export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** A raw EC P-256 public point is exactly 65 bytes (0x04 + 32-byte X +
 *  32-byte Y) -- true for every real VAPID public key, and the same check
 *  the client applies to VITE_VAPID_PUBLIC_KEY (src/push/vapidKey.ts) --
 *  kept independently here since this Deno module cannot import that Vite
 *  client module directly. */
const RAW_EC_POINT_LENGTH = 65;
const UNCOMPRESSED_POINT_PREFIX = 0x04;

function urlBase64ToUint8Array(base64UrlString: string): Uint8Array {
  const padding = "=".repeat((4 - (base64UrlString.length % 4)) % 4);
  const base64 = (base64UrlString + padding).replace(/-/g, "+").replace(
    /_/g,
    "/",
  );
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function isValidVapidPublicKey(key: string): boolean {
  try {
    const bytes = urlBase64ToUint8Array(key);
    return bytes.length === RAW_EC_POINT_LENGTH &&
      bytes[0] === UNCOMPRESSED_POINT_PREFIX;
  } catch {
    return false;
  }
}

// A real VAPID private key is a 32-byte EC scalar, base64url-encoded to 43
// characters (no padding). This is a coarse sanity floor (catches an empty
// string, a placeholder, or an obviously truncated value) -- web-push's own
// setVapidDetails/sendNotification is the actual cryptographic validator;
// this never tries to re-implement that.
const MIN_PLAUSIBLE_PRIVATE_KEY_LENGTH = 20;

function isValidSubject(subject: string): boolean {
  return /^mailto:.+@.+/i.test(subject) || /^https?:\/\/.+/i.test(subject);
}

/**
 * Resolves and validates VAPID config from the given env-var reader
 * (injected so tests never touch real Deno.env, and so real-value fixtures
 * never appear in source -- see vapidConfig.test.ts, which uses only
 * obviously-fake generated test keys).
 */
export function resolveVapidConfig(
  getEnv: (name: string) => string | undefined,
): VapidConfig | null {
  const publicKey = getEnv("VAPID_PUBLIC_KEY")?.trim();
  const privateKey = getEnv("VAPID_PRIVATE_KEY")?.trim();
  const subject = getEnv("VAPID_SUBJECT")?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (!isValidVapidPublicKey(publicKey)) return null;
  if (privateKey.length < MIN_PLAUSIBLE_PRIVATE_KEY_LENGTH) return null;
  if (!isValidSubject(subject)) return null;
  return { publicKey, privateKey, subject };
}
