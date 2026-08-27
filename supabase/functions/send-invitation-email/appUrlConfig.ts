// Resolves AVARIA's own canonical application URL from a server-only Edge
// Function secret (AVARIA_APP_URL) -- NEVER from the request body, a
// browser Origin/Referer header, or anything else the caller sends. The
// invitation email's "כניסה ל-AVARIA" link and logo image both come only
// from this trusted value: a caller who can invoke this function is
// already authorized (get_pending_personnel_invitation_target, run under
// their own JWT), but authorization to send an invitation must never
// extend to choosing WHERE an AVARIA-branded email points -- that stays a
// deployment-level fact the owner configures once, exactly like
// send-push-notification's VAPID_* secrets (vapidConfig.ts), not a
// per-request input.
//
// An absent/invalid setting resolves to `null` rather than throwing, so
// the caller fails safely (no send attempted, a logged server-side
// configuration error, the outcome recorded as 'failed') instead of
// crashing the whole invocation -- same discipline as resolveVapidConfig.

const MAX_URL_LENGTH = 200;

/**
 * Resolves and validates the trusted app URL from the given env-var reader
 * (injected so tests never touch real Deno.env -- see
 * appUrlConfig.test.ts). Returns a normalized `https://host[:port]` origin
 * (no path, query, hash, or credentials -- stripped even if the configured
 * value included them) only when the value is a well-formed, non-empty,
 * plausibly-sized `https:` URL; otherwise null. Never throws. Deliberately
 * requires `https:` strictly -- this value is embedded directly into a
 * branded email sent to real people, not a local-dev convenience.
 */
export function resolveAppUrl(
  getEnv: (name: string) => string | undefined,
): string | null {
  const raw = getEnv("AVARIA_APP_URL")?.trim();
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return `${url.protocol}//${url.host}`;
}
