// Inbound webhook authentication for send-push-notification. This function
// is database-triggered (migration 0054's dispatch_push_notification()),
// never user-triggered -- there is no Supabase Auth JWT to check, only a
// dedicated shared secret the database reads from Vault
// (avaria_push_dispatch_url/avaria_push_webhook_secret) and this function
// reads from its own PUSH_WEBHOOK_SECRET environment variable. Deliberately
// NOT the VAPID private key, the anon/publishable key, or any user JWT.
import { timingSafeEqual } from "node:crypto";

export const PUSH_SECRET_HEADER = "x-avaria-push-secret";

/**
 * True only when `provided` exactly matches `expected`, compared in
 * constant time (Node's timingSafeEqual, available under Deno via the
 * node: compat layer) so a byte-by-byte guessing attack can't learn the
 * secret from response-time differences. A length mismatch is checked
 * first (timingSafeEqual requires equal-length buffers) -- this leaks only
 * that lengths differ, never which byte first differs, an accepted
 * trade-off for a fixed-length random token compared against a
 * fixed-length random secret.
 *
 * Returns false (never throws) for a missing header or missing/blank
 * configured secret -- the caller must not distinguish "no header" from
 * "wrong secret" in its response, only in this boolean.
 */
export function verifyWebhookSecret(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!provided || !expected) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
