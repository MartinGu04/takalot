// Core send-push-notification processing flow -- pure orchestration logic
// over the injected DispatchDeps, with no direct supabase-js/web-push/Deno.serve
// dependency, so it is fully unit-testable (see dispatch.test.ts) without a
// real database, a real Push provider, or a real Supabase Edge Runtime.
// index.ts wires this to the real world.
import { verifyWebhookSecret } from "./webhookAuth.ts";
import type {
  DispatchDeps,
  DispatchOutcome,
  DispatchRequest,
  NotificationRow,
  SubscriptionOutcome,
  SubscriptionRow,
} from "./types.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Approved v1.5 send policy -- MUST mirror migration 0054's trigger WHEN
 *  clause exactly. Re-checked here as defense in depth: this function must
 *  never trust that only qualifying rows can reach it (e.g. a manually
 *  reinvoked webhook, a future trigger edit that loosens the WHEN clause). */
export function qualifiesForPush(
  row: Pick<NotificationRow, "category" | "type">,
): boolean {
  return row.category === "action_required" ||
    (row.category === "update" && row.type === "incident_opened");
}

const TITLE = "AVARIA";

/**
 * Approved fixed lock-screen copy (never notifications.text, never any
 * operational field) -- see the Phase 5A implementation notes' "exact Push
 * payload policy". Returns null only when `row` does not actually match
 * any approved copy rule (defense in depth alongside qualifiesForPush --
 * should be unreachable in normal operation since the caller already
 * checked qualifiesForPush first).
 *
 * `actorName`, when a non-blank string, appends " · ע״י <name>" -- the ONLY
 * additional context approved for these notifications (Push actor name
 * polish). Omitted/null/blank leaves the copy exactly as before: the caller
 * must never fail, delay, or suppress delivery just because the actor could
 * not be resolved (see handleDispatch).
 */
export function buildPushBody(
  row: Pick<NotificationRow, "category" | "type">,
  actorName?: string | null,
): string | null {
  const suffix = actorName && actorName.trim().length > 0
    ? ` · ע״י ${actorName.trim()}`
    : "";
  if (row.category === "update" && row.type === "incident_opened") {
    return "נפתחה תקלה חדשה" + suffix;
  }
  if (row.category === "action_required" && row.type === "incident_reopened") {
    return "תקלה שבאחריותך נפתחה מחדש" + suffix;
  }
  if (row.category === "action_required") {
    return "תקלה שויכה אליך" + suffix;
  }
  return null;
}

/** Extracts and validates `notification_id` from the parsed webhook body --
 *  the ONLY field migration 0054's trigger ever sends. Malformed input
 *  (missing, wrong type, not a UUID shape) returns null; the caller treats
 *  that as a safe 400, never an exception. */
export function extractNotificationId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>).notification_id;
  if (typeof value !== "string" || !UUID_RE.test(value)) return null;
  return value;
}

const MAX_DELIVERY_ERROR_LENGTH = 2000; // matches push_deliveries.error's own check constraint (migration 0053)

function truncateError(message: string): string {
  return message.length > MAX_DELIVERY_ERROR_LENGTH
    ? message.slice(0, MAX_DELIVERY_ERROR_LENGTH)
    : message;
}

/**
 * Processes exactly one subscription: atomic claim, send, outcome
 * recording. Never throws -- an unexpected error from any injected
 * dependency degrades to a 'failed' outcome for THIS subscription only, so
 * one dead/misbehaving device can never prevent attempts to the same
 * user's other devices (Promise.all over independent calls to this
 * function is what actually guarantees that -- see dispatchToSubscriptions
 * below).
 */
async function processSubscription(
  notification: NotificationRow,
  subscription: SubscriptionRow,
  payload: { title: string; body: string; incidentId: string },
  deps: DispatchDeps,
): Promise<SubscriptionOutcome> {
  try {
    const claimed = await deps.claimDelivery(notification.id, subscription.id);
    if (!claimed) return "duplicate";

    const result = await deps.sendPush(subscription, payload);
    if (result.outcome === "sent") {
      await deps.markDeliverySent(
        notification.id,
        subscription.id,
        result.statusCode,
      );
      return "sent";
    }
    if (result.outcome === "expired") {
      await deps.markDeliveryExpired(
        notification.id,
        subscription.id,
        result.statusCode,
      );
      await deps.removeSubscription(subscription.id);
      return "expired";
    }
    await deps.markDeliveryFailed(
      notification.id,
      subscription.id,
      truncateError(result.message),
      result.statusCode,
    );
    return "failed";
  } catch (err) {
    // Never let a thrown error (a claim/mark/remove call, or sendPush
    // itself) escape -- this subscription is simply recorded as failed;
    // the surrounding Promise.all still lets every other subscription for
    // this user proceed independently.
    console.error(
      "send-push-notification: unexpected error processing subscription",
      subscription.id,
      err instanceof Error ? err.message : String(err),
    );
    return "failed";
  }
}

async function dispatchToSubscriptions(
  notification: NotificationRow,
  subscriptions: SubscriptionRow[],
  payload: { title: string; body: string; incidentId: string },
  deps: DispatchDeps,
): Promise<
  { sent: number; failed: number; expired: number; duplicate: number }
> {
  const outcomes = await Promise.all(
    subscriptions.map((subscription) =>
      processSubscription(notification, subscription, payload, deps)
    ),
  );
  return {
    sent: outcomes.filter((o) => o === "sent").length,
    failed: outcomes.filter((o) => o === "failed").length,
    expired: outcomes.filter((o) => o === "expired").length,
    duplicate: outcomes.filter((o) => o === "duplicate").length,
  };
}

/**
 * The full processing flow described in the Phase 5A implementation notes:
 * authenticate -> parse -> re-fetch canonical row -> re-check policy ->
 * require incident_id -> require an active recipient -> require configured
 * VAPID -> fetch subscriptions -> claim + send each, independently.
 *
 * Every non-2xx-worthy outcome still returns HTTP 200 with a `skipped`/`ok`
 * body (never a 4xx/5xx) EXCEPT the two request-shape failures
 * (unauthorized, bad_request) -- a "this row doesn't qualify" or "no
 * subscriptions" outcome is not an error, it is the intended zero-send
 * result the database's fire-and-forget pg_net call should never treat as
 * needing a retry (v1.5 has none anyway).
 */
export async function handleDispatch(
  request: DispatchRequest,
  deps: DispatchDeps,
  expectedSecret: string | null | undefined,
): Promise<DispatchOutcome> {
  if (!verifyWebhookSecret(request.secretHeader, expectedSecret)) {
    return { status: 401, body: { result: "unauthorized" } };
  }

  const notificationId = extractNotificationId(request.body);
  if (!notificationId) {
    return { status: 400, body: { result: "bad_request" } };
  }

  const notification = await deps.fetchNotification(notificationId);
  if (!notification) {
    return { status: 200, body: { result: "not_found" } };
  }

  if (!qualifiesForPush(notification)) {
    return { status: 200, body: { result: "skipped", reason: "policy" } };
  }

  if (!notification.incident_id) {
    return {
      status: 200,
      body: { result: "skipped", reason: "no_incident_id" },
    };
  }

  const active = await deps.isRecipientActive(notification.user_id);
  if (!active) {
    return {
      status: 200,
      body: { result: "skipped", reason: "inactive_recipient" },
    };
  }

  if (!deps.vapidConfigured) {
    console.error(
      "send-push-notification: VAPID environment configuration missing/invalid -- no provider call attempted",
    );
    return {
      status: 200,
      body: { result: "skipped", reason: "vapid_unconfigured" },
    };
  }

  const subscriptions = await deps.fetchSubscriptions(notification.user_id);
  if (subscriptions.length === 0) {
    return {
      status: 200,
      body: {
        result: "ok",
        attempted: 0,
        sent: 0,
        failed: 0,
        expired: 0,
        duplicate: 0,
      },
    };
  }

  // Actor name resolution (Push actor name polish) -- best-effort only.
  // notification.actor_id is null for legacy/unattributed rows, and any
  // failure here (lookup error, missing/blank profile) must never block,
  // delay, or otherwise affect delivery -- it only ever changes whether the
  // copy gains the " · ע״י <name>" suffix below.
  let actorName: string | null = null;
  if (notification.actor_id) {
    try {
      actorName = await deps.fetchActorDisplayName(notification.actor_id);
    } catch (err) {
      console.error(
        "send-push-notification: actor display-name lookup failed -- continuing without actor suffix",
        err instanceof Error ? err.message : String(err),
      );
      actorName = null;
    }
  }

  const body = buildPushBody(notification, actorName);
  if (!body) {
    // Unreachable in normal operation (qualifiesForPush already agreed),
    // kept as defense in depth -- never guess a fallback copy.
    return { status: 200, body: { result: "skipped", reason: "no_payload" } };
  }

  const { sent, failed, expired, duplicate } = await dispatchToSubscriptions(
    notification,
    subscriptions,
    { title: TITLE, body, incidentId: notification.incident_id },
    deps,
  );

  return {
    status: 200,
    body: {
      result: "ok",
      attempted: subscriptions.length,
      sent,
      failed,
      expired,
      duplicate,
    },
  };
}
