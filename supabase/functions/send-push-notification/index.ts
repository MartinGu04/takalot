// AVARIA v1.5.0 Phase 5A -- server-side Web Push dispatch. Invoked ONLY by
// migration 0054's dispatch_push_notification() trigger, via pg_net, with
// a minimal `{"notification_id": "<uuid>"}` body and a dedicated
// `x-avaria-push-secret` header (see webhookAuth.ts) -- never by a
// browser, never with a Supabase Auth JWT. This is exactly why
// supabase/config.toml sets verify_jwt = false for this function: the
// platform's own gateway JWT gate would otherwise reject every call before
// this code ever runs, since pg_net's request carries no such JWT.
//
// This file is intentionally thin: authenticate -> parse body -> delegate
// to dispatch.ts's handleDispatch with the real database/web-push/VAPID
// wiring below. All actual policy/processing logic lives in dispatch.ts,
// which is what dispatch.test.ts exercises without any of this file's I/O.
//
// NOT deployed by this change -- `supabase functions deploy
// send-push-notification` is a separate, explicit Phase 5B step, run only
// with hosted credentials this environment does not have (see
// docs/phase5b-push-activation.md).
import { createClient } from "@supabase/supabase-js";
import { handleDispatch } from "./dispatch.ts";
import { PUSH_SECRET_HEADER } from "./webhookAuth.ts";
import { resolveVapidConfig } from "./vapidConfig.ts";
import { createWebPushSender } from "./webPushSender.ts";
import { createDatabaseDeps } from "./databaseDeps.ts";
import type { DispatchDeps, DispatchRequest } from "./types.ts";

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Same JSON-dictionary-first, legacy-fallback resolution as delete-user/index.ts
// (SUPABASE_SECRET_KEYS / SUPABASE_SERVICE_ROLE_KEY) -- kept consistent
// with this repository's one other Edge Function rather than inventing a
// second convention.
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
const serviceRoleKey = resolveKey(
  "SUPABASE_SECRET_KEYS",
  "SUPABASE_SERVICE_ROLE_KEY",
);
const pushWebhookSecret = Deno.env.get("PUSH_WEBHOOK_SECRET");
const vapidConfig = resolveVapidConfig((name) => Deno.env.get(name));

if (!supabaseUrl || !serviceRoleKey) {
  // Fails loudly at module load, matching delete-user's own per-request
  // check -- logged server-side only, never a value leaked to a caller.
  console.error(
    "send-push-notification: missing required environment configuration (SUPABASE_URL / service role key)",
  );
}
if (!pushWebhookSecret) {
  console.error(
    "send-push-notification: PUSH_WEBHOOK_SECRET is not configured -- every request will be rejected as unauthorized",
  );
}
if (!vapidConfig) {
  console.error(
    "send-push-notification: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT missing or invalid -- no Push send will ever be attempted until this is corrected",
  );
}

const client = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  })
  : null;

const deps: DispatchDeps | null = client
  ? {
    ...createDatabaseDeps(client),
    vapidConfigured: vapidConfig !== null,
    // Unreachable in practice -- handleDispatch checks vapidConfigured and
    // skips before ever calling sendPush -- but DispatchDeps still needs a
    // total implementation.
    sendPush: vapidConfig
      ? createWebPushSender(vapidConfig)
      : () =>
        Promise.resolve({
          outcome: "failed" as const,
          message: "VAPID is not configured.",
        }),
  }
  : null;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json(405, { error: "method_not_allowed", message: "Use POST." });
  }
  if (!deps) {
    console.error(
      "send-push-notification: rejecting request -- function environment is not configured",
    );
    return json(500, { error: "server_misconfigured" });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    // handleDispatch's own notification_id validation rejects `null` with
    // a safe 400 -- no separate branch needed here. Authentication still
    // runs first regardless (see handleDispatch), so a malformed body from
    // an UNauthenticated caller still gets a generic 401, not a 400 that
    // would confirm "you reached the parsing stage".
  }

  const request: DispatchRequest = {
    secretHeader: req.headers.get(PUSH_SECRET_HEADER),
    body,
  };

  const outcome = await handleDispatch(request, deps, pushWebhookSecret);
  return json(outcome.status, outcome.body);
});
