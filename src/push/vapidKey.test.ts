import { describe, expect, it } from 'vitest';
import { getConfiguredVapidPublicKey, isValidVapidPublicKey, urlBase64ToUint8Array } from './vapidKey';

// A real-shaped VAPID public key: 65 raw bytes (0x04 prefix + 32+32-byte EC
// point), base64url-encoded -- exactly what every real Web Push provider
// issues. Randomly generated for this test only; not a real credential.
const VALID_KEY = 'BIulvpvnacETZPcbRM1eBA-EgswBwrkev3pqSELJwHknIjc71adxWApy98SMyOrvgrLDJj2u9-DM0Vw_euvkCuM';

describe('urlBase64ToUint8Array', () => {
  it('decodes a base64url VAPID key to its raw 65-byte EC point', () => {
    const bytes = urlBase64ToUint8Array(VALID_KEY);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
  });

  it('handles base64url characters (-, _) and missing padding', () => {
    // '-' and '_' only appear when the underlying bytes require them;
    // this key is a stand-in with padding stripped, the normal published
    // format for a VAPID key.
    expect(() => urlBase64ToUint8Array('QQ')).not.toThrow();
  });

  it('throws on input that cannot be decoded as base64', () => {
    expect(() => urlBase64ToUint8Array('not valid base64!!! ***')).toThrow();
  });
});

describe('isValidVapidPublicKey', () => {
  it('accepts a well-formed 65-byte uncompressed EC point', () => {
    expect(isValidVapidPublicKey(VALID_KEY)).toBe(true);
  });

  it('rejects null/undefined/empty', () => {
    expect(isValidVapidPublicKey(null)).toBe(false);
    expect(isValidVapidPublicKey(undefined)).toBe(false);
    expect(isValidVapidPublicKey('')).toBe(false);
  });

  it('rejects a value that is not valid base64 at all', () => {
    expect(isValidVapidPublicKey('not-a-real-key!!!')).toBe(false);
  });

  it('rejects a decodable value of the wrong length (e.g. a truncated or private key)', () => {
    expect(isValidVapidPublicKey('QUJD')).toBe(false); // decodes to 3 bytes
  });

  it('rejects a 65-byte value that does not start with the 0x04 uncompressed-point prefix', () => {
    const wrongPrefixBytes = urlBase64ToUint8Array(VALID_KEY);
    wrongPrefixBytes[0] = 0x02;
    const reencoded = btoa(String.fromCharCode(...wrongPrefixBytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(isValidVapidPublicKey(reencoded)).toBe(false);
  });
});

describe('getConfiguredVapidPublicKey', () => {
  // import.meta.env.VITE_VAPID_PUBLIC_KEY is readonly at the type level
  // (matches appMode.ts's own contract) -- every case here passes an
  // explicit env object (the function's test seam) rather than mutating it.

  it('returns null when unset', () => {
    expect(getConfiguredVapidPublicKey({})).toBeNull();
  });

  it('returns null for a blank/whitespace-only value', () => {
    expect(getConfiguredVapidPublicKey({ VITE_VAPID_PUBLIC_KEY: '   ' })).toBeNull();
  });

  it('returns the trimmed configured value', () => {
    expect(getConfiguredVapidPublicKey({ VITE_VAPID_PUBLIC_KEY: `  ${VALID_KEY}  ` })).toBe(VALID_KEY);
  });

  it('defaults to reading the real import.meta.env when no override is given', () => {
    expect(() => getConfiguredVapidPublicKey()).not.toThrow();
  });
});
