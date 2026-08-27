// Server-side half of AVARIA's invitation email. Same shape as
// delete-user/index.ts: this function holds NO authorization logic of its
// own -- Postgres is the authority (see migration 0060). It only:
//   1. Forwards the caller's own JWT into a Supabase client so
//      get_pending_personnel_invitation_target() and
//      record_pending_personnel_invitation_result() both run under the
//      CALLER's identity -- the exact same role-ceiling check
//      create_pending_personnel already enforces applies here too.
//   2. Only once step 1 has authorized the caller and returned the
//      recipient's name/email/role, calls the email provider (Resend) --
//      the one genuinely server-only step, using an API key that is
//      never accepted from, or exposed to, the browser/request.
//   3. Records the outcome (sent/failed) back through the caller-scoped
//      client, so an admin resending later and the personnel page's own
//      badge both see the true, current state.
//
// A failed SEND is not a failed REQUEST: this function still returns 200
// with { outcome: 'failed', message } so the frontend can show "person
// created, but the invitation email failed" rather than treating it as a
// mutation error -- exactly the distinction the personnel-management UX
// requires (see PersonnelPage.tsx). Only genuine request problems
// (missing auth, bad body, the caller not being authorized, misconfigured
// server secrets) are non-2xx.
//
// NOT deployed by this change -- `supabase functions deploy
// send-invitation-email` is a separate, explicit step, run only with
// hosted credentials this environment does not have, same as delete-user
// and send-push-notification.
import { createClient } from "@supabase/supabase-js";
import { buildInvitationEmail } from "./invitationEmail.ts";
import { sanitizeAppOrigin } from "./originValidation.ts";
import { createResendSender } from "./resendSender.ts";
import type { InvitationRecipient } from "./types.ts";

// Identical CORS header set to delete-user/index.ts -- see that file's own
// comment for why each header is required (supabase-js's functions.invoke
// always sends authorization/x-client-info/apikey/content-type).
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// get_pending_personnel_invitation_target/record_pending_personnel_invitation_result
// raise plain-text exceptions with the same permission:/not_found:/
// validation: prefixes every RPC in this schema uses -- mapped to stable
// HTTP status codes here, exactly like delete-user's own
// statusForKnownRpcError. Anything unrecognized is logged server-side only.
function statusForKnownRpcError(message: string): number | null {
  if (/^permission:/.test(message)) return 403;
  if (/^not_found:/.test(message)) return 404;
  if (/^validation:/.test(message)) return 409;
  return null;
}

// Same JSON-dictionary-first, legacy-fallback resolution as
// delete-user/index.ts and send-push-notification/index.ts.
function resolveKey(
  jsonEnvVar: string,
  legacyEnvVar: string,
): string | undefined {
  const raw = Deno.env.get(jsonEnvVar);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const value = parsed?.default;
      if (typeof value === "string" && value.length > 0) return value;
    } catch {
      // Malformed JSON: fall through to the legacy variable below.
    }
  }
  return Deno.env.get(legacyEnvVar);
}

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const anonKey = resolveKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
const resendApiKey = Deno.env.get("RESEND_API_KEY");
const resendFromAddress = Deno.env.get("RESEND_FROM_EMAIL");

if (!supabaseUrl || !anonKey) {
  console.error(
    "send-invitation-email: missing required environment configuration (url/publishable key)",
  );
}
if (!resendApiKey || !resendFromAddress) {
  console.error(
    "send-invitation-email: RESEND_API_KEY / RESEND_FROM_EMAIL not configured -- every send will be recorded as failed until this is corrected",
  );
}

const sendEmail = resendApiKey && resendFromAddress
  ? createResendSender({ apiKey: resendApiKey, fromAddress: resendFromAddress })
  : null;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json(405, { error: "method_not_allowed", message: "Use POST." });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !/^Bearer\s+.+/i.test(authHeader)) {
    return json(401, { error: "missing_authorization", message: "Missing bearer token." });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_body", message: "Request body must be JSON." });
  }
  const record = body as Record<string, unknown> | null;
  const pendingPersonnelId = record?.pendingPersonnelId;
  if (typeof pendingPersonnelId !== "string" || !UUID_RE.test(pendingPersonnelId)) {
    return json(400, { error: "invalid_pending_personnel_id", message: "pendingPersonnelId must be a UUID string." });
  }
  // The requesting page's own origin -- used only to build the email's
  // login link/logo image (see originValidation.ts). Absent or malformed
  // simply degrades the email to a text-only login instruction; it never
  // fails the request.
  const appOrigin = sanitizeAppOrigin(record?.origin);

  if (!supabaseUrl || !anonKey) {
    console.error("send-invitation-email: rejecting request -- function environment is not configured");
    return json(500, { error: "server_misconfigured", message: "Function environment is not configured." });
  }

  // Caller-scoped client: BOTH RPCs below run as THIS caller, under the
  // exact same role-ceiling check create_pending_personnel already
  // enforces for registering the entry in the first place.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: targetRow, error: targetError } = await callerClient.rpc(
    "get_pending_personnel_invitation_target",
    { p_id: pendingPersonnelId },
  );
  if (targetError) {
    const knownStatus = statusForKnownRpcError(targetError.message);
    if (knownStatus === null) {
      console.error("send-invitation-email: unrecognized get_pending_personnel_invitation_target error:", targetError.message);
      return json(500, { error: "internal_error", message: "An unexpected error occurred." });
    }
    return json(knownStatus, { error: "db_step_failed", message: targetError.message });
  }

  const recipient: InvitationRecipient = {
    fullName: (targetRow as Record<string, unknown>).full_name as string,
    email: (targetRow as Record<string, unknown>).email as string,
    role: (targetRow as Record<string, unknown>).role as InvitationRecipient["role"],
  };
  const { subject, html, text } = buildInvitationEmail(recipient, appOrigin);

  const outcome = sendEmail
    ? await sendEmail({ to: recipient.email, subject, html, text })
    : { outcome: "failed" as const, message: 'תצורת שליחת הדוא"ל בצד השרת חסרה.' };

  // Best-effort recording: a failure to WRITE the outcome must never
  // change what is reported back to the admin about whether the email
  // itself actually sent -- the personnel page's next refetch of
  // list_personnel() will simply lag until the next successful record.
  const { error: recordError } = await callerClient.rpc(
    "record_pending_personnel_invitation_result",
    {
      p_id: pendingPersonnelId,
      p_status: outcome.outcome,
      p_error: outcome.outcome === "failed" ? outcome.message ?? null : null,
    },
  );
  if (recordError) {
    console.error("send-invitation-email: failed to record invitation result:", recordError.message);
  }

  return json(200, outcome);
});
