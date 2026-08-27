// Sanitizes a client-supplied page origin (window.location.origin) for use
// in the invitation email's "כניסה ל-AVARIA" link and logo image. This
// project has no canonical server-side "production URL" secret -- the
// frontend already derives its own origin from window.location.origin at
// runtime for the exact same purpose (see AuthContext.tsx's Google OAuth
// redirectTo). Reusing that same convention here means the emailed link
// always matches whichever deployment (production, a Vercel preview,
// localhost during local development) the admin who triggered the
// invitation was actually using -- exactly like the OAuth redirect does,
// with no extra secret to configure or keep in sync across environments.
//
// This is NOT an authorization boundary: by the time this module runs, the
// caller has already been authorized server-side by
// get_pending_personnel_invitation_target (a role-ceiling-checked RPC run
// under the CALLER's own JWT, not this function's own logic) -- a forged
// origin can at worst point their own invitation email's link somewhere
// unexpected. It can never grant anyone access: claim_pending_personnel
// authorizes purely by matching a verified Google email against the
// pending row, never by anything carried in a URL. Validation here exists
// only to keep the email well-formed and refuse anything that is not a
// plain http(s) origin (e.g. a `javascript:` string, free text, or
// something absurdly long).

const MAX_ORIGIN_LENGTH = 200;

/**
 * Returns a normalized `scheme://host[:port]` origin (no path, query,
 * hash, or credentials -- those are stripped even if the caller's raw
 * string included them) when `candidate` is a well-formed http(s) URL
 * short enough to be a real page origin; otherwise null. Never throws.
 */
export function sanitizeAppOrigin(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.length > MAX_ORIGIN_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.protocol}//${url.host}`;
}
