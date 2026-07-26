// Server-side half of user deletion. This function contains NO
// authorization logic of its own -- Postgres is the authority (see
// migrations/0013_admin_delete_user.sql). It only:
//   1. Forwards the caller's own JWT into a Supabase client so
//      admin_delete_user() runs under the CALLER's identity -- every
//      permission/role-ceiling/last-admin/open-incident check in that RPC
//      applies exactly as it would for any other RPC call made directly
//      from the browser.
//   2. Only if that RPC succeeds, uses a SEPARATE client built from the
//      service-role key (a function-only environment variable, injected
//      automatically by the Supabase platform -- never accepted from or
//      exposed to the browser/request) to delete the Supabase Auth
//      account.
//
// Both steps are individually idempotent, which makes the whole flow safe
// to retry and safe under a race between two authorized requests for the
// same target:
//   - admin_delete_user() no-ops on an already-tombstoned target, but
//     ONLY after the caller's own authorization has already been
//     established (see the migration) -- an unauthorized caller can never
//     turn a deleted user's id into a false "success".
//   - An Auth Admin "user not found" response is treated as success
//     here, not failure -- so a retry after a prior Auth-delete failure,
//     or a second request that raced the first past the DB step, both
//     converge on "deleted" rather than erroring twice or leaving the
//     first caller's success in doubt.
//
// NOT deployed by this PR -- `supabase functions deploy delete-user` is a
// separate, explicit step, run only with hosted credentials this
// environment does not have.

import { createClient } from 'npm:@supabase/supabase-js@2';

// One shared, explicit CORS header set -- used identically for the
// OPTIONS preflight, every success response, and every error response
// (via json() below), so the browser never sees a mismatch between them.
//
// supabase-js's client (used by callerClient.rpc(...) from the browser via
// functions.invoke()) always sends 'apikey' and 'x-client-info' in
// addition to 'authorization'/'content-type' -- omitting either from
// Access-Control-Allow-Headers fails the preflight and the POST request
// never reaches this handler at all. A pinned-version SDK import (e.g.
// `npm:@supabase/supabase-js@2/cors`) was considered instead of this
// literal list, but this function targets `npm:@supabase/supabase-js@2`
// (unpinned patch version) for the Deno/Supabase Edge Runtime, which is a
// different resolution environment than this repo's Node install -- an
// explicit, dependency-free header list is the safer choice here.
// Functional method handling is unaffected either way: only POST (and the
// OPTIONS preflight itself) does anything below.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// admin_delete_user() raises plain-text exceptions with the same
// permission:/not_found:/validation: prefixes the frontend already parses
// (supabaseRepository.ts's wrap()) -- mapped to stable HTTP status codes
// here rather than relying only on the message text. Anything that does
// NOT match one of these known, safe business-error prefixes is treated
// as unrecognized (see the null return) -- its raw text must never reach
// the client (a Postgres/PostgREST error can carry schema/query detail).
function statusForKnownRpcError(message: string): number | null {
  if (/^permission:/.test(message)) return 403;
  if (/^not_found:/.test(message)) return 404;
  if (/^validation:/.test(message)) return 409;
  return null;
}

// Resolves the current Supabase API-key environment variables first
// (SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS -- JSON dictionaries
// keyed by name, "default" being the active key), falling back to the
// legacy single-value variables only if the JSON variable or its
// "default" entry is absent -- kept for deployment compatibility.
function resolveKey(jsonEnvVar: string, legacyEnvVar: string): string | undefined {
  const raw = Deno.env.get(jsonEnvVar);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const value = parsed?.default;
      if (typeof value === 'string' && value.length > 0) return value;
    } catch {
      // Malformed JSON: fall through to the legacy variable below.
    }
  }
  return Deno.env.get(legacyEnvVar);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'method_not_allowed', message: 'Use POST.' });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !/^Bearer\s+.+/i.test(authHeader)) {
    return json(401, { error: 'missing_authorization', message: 'Missing bearer token.' });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'invalid_body', message: 'Request body must be JSON.' });
  }
  const userId = (body as Record<string, unknown> | null)?.userId;
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return json(400, { error: 'invalid_user_id', message: 'userId must be a UUID string.' });
  }

  // Only this function's OWN environment variables are ever used for the
  // service-role client below -- a service-role key submitted by the
  // caller (body, headers, anywhere in the request) would simply be
  // ignored; there is no code path that reads one from the request.
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = resolveKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
  const serviceRoleKey = resolveKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error('delete-user: missing required environment configuration (url/publishable/secret key)');
    return json(500, { error: 'server_misconfigured', message: 'Function environment is not configured.' });
  }

  // Caller-scoped client: admin_delete_user() runs as THIS caller, under
  // the exact same RPC/permission checks as any other client call.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { error: rpcError } = await callerClient.rpc('admin_delete_user', { p_user_id: userId });
  if (rpcError) {
    const knownStatus = statusForKnownRpcError(rpcError.message);
    if (knownStatus === null) {
      // Not one of the RPC's own permission:/not_found:/validation:
      // business errors -- could be a raw Postgres/PostgREST error
      // (constraint detail, column names, etc.). Log it server-side only
      // and return a generic message; never forward the raw text.
      console.error('delete-user: unrecognized admin_delete_user error:', rpcError.message);
      return json(500, { error: 'internal_error', message: 'An unexpected error occurred.' });
    }
    return json(knownStatus, { error: 'db_step_failed', message: rpcError.message });
  }

  // Only past this point does the service-role key get used, and only
  // for Auth Admin deletion.
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const { error: authError } = await adminClient.auth.admin.deleteUser(userId);

  if (authError) {
    const err = authError as { status?: number; code?: string };
    const alreadyAbsent = err.status === 404 || err.code === 'user_not_found';
    if (!alreadyAbsent) {
      // A genuine failure here is always safe to retry: the profile is
      // already tombstoned, so it has no access regardless of whether
      // the Auth account still exists. Log server-side only; the client
      // gets a generic, safe, retryable message -- never the raw error.
      console.error('delete-user: Auth admin.deleteUser failed:', authError.message);
      return json(502, {
        error: 'auth_delete_failed',
        message: 'Profile was tombstoned but the Auth account could not be deleted. Safe to retry.',
        retryable: true,
      });
    }
  }

  return json(200, { deletedUserId: userId });
});
