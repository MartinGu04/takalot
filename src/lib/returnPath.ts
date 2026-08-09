// Validates a post-login return destination as a safe, INTERNAL AVARIA path.
//
// This is NOT a general-purpose URL sanitizer -- it exists solely to let the
// Google OAuth round trip carry the page a signed-out user was trying to
// reach (e.g. a push-notification deep link to /incidents/{id}) back to them
// after authentication, without ever becoming an open redirect.
//
// Deliberately an ALLOWLIST of known-safe shapes rather than a permissive
// "any relative path" check: a permissive check has to separately defend
// against protocol-relative URLs, backslash-as-slash browser normalization,
// percent-encoded tricks, and opaque schemes (javascript:, data:, ...). An
// allowlist sidesteps all of that -- anything not matching a known-safe
// shape is rejected outright.
//
// incidents.id is a Postgres `uuid` (`default gen_random_uuid()` --
// supabase/migrations/0001_schema.sql), so that is the shape checked here.
const UUID_SOURCE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const INCIDENT_PATH = new RegExp(`^/incidents/${UUID_SOURCE}$`);

// An arbitrary same-origin base used only to let the platform URL parser do
// the actual scheme/host resolution -- the one part of this check that must
// exactly match real browser navigation behavior (including backslash and
// percent-encoding quirks), rather than being re-implemented by hand here.
const PARSE_BASE = 'https://avaria.invalid';

/**
 * Returns `value` unchanged (as `pathname + search + hash`) if it is a safe
 * internal AVARIA destination this app is willing to navigate to right after
 * login, otherwise `null`. Both the write side (embedding `next` in the
 * OAuth `redirectTo`) and the read side (after landing back on `/login`)
 * must call this -- it is the single source of truth for the check.
 */
export function sanitizeInternalReturnPath(value: string | null | undefined): string | null {
  if (!value) return null;
  // Required up front, in addition to the origin check below: the WHATWG URL
  // parser resolves a schemeless, slash-less value like "incidents/x"
  // against the base's root and would otherwise report it as same-origin.
  if (!value.startsWith('/') || value.startsWith('//')) return null;

  let parsed: URL;
  try {
    parsed = new URL(value, PARSE_BASE);
  } catch {
    return null;
  }
  // Catches everything else: absolute http(s) URLs, opaque schemes
  // (javascript:, data:, ...), and backslash/encoding tricks the parser
  // itself resolves into a different origin (e.g. "/\evil.example" is
  // treated as "//evil.example" by the URL spec for special schemes).
  if (parsed.origin !== PARSE_BASE) return null;

  if (!INCIDENT_PATH.test(parsed.pathname)) return null;

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
