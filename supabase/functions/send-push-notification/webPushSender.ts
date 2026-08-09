// Real Web Push transport: web-push (npm, pinned -- see deno.json) over the
// configured VAPID keypair. Split into a pure error-classification function
// (classifyWebPushError, unit-testable with plain fake Error objects, no
// network/library call) and createWebPushSender, the thin real-I/O wrapper
// dispatch.ts's DispatchDeps.sendPush actually needs. Never logs
// subscription.p256dh/auth_key or VAPID key material -- only the outcome
// and, on failure, the provider's own error message/status code.
import webpush from "web-push";
import type { PushPayload, SendPushResult, SubscriptionRow } from "./types.ts";
import type { VapidConfig } from "./vapidConfig.ts";

// Explicit, short, operational TTL (seconds) -- deliberately NOT the
// library's unset-TTL behavior, which lets the push service apply its own
// (potentially multi-week) default. An AVARIA incident Push is a nudge to
// open the app and look at current state; the underlying incident can be
// reassigned, updated, or closed within minutes, so a copy of "you were
// assigned/an incident opened" that only reaches a device HOURS later,
// after being queued by an offline device's push service, is already
// stale and should simply expire rather than surface out of context. One
// hour balances that against giving a briefly-offline device (a phone that
// reconnects a few minutes later) a real chance to still receive it.
export const PUSH_TTL_SECONDS = 3600;

// Explicit per-send SOCKET timeout (milliseconds) -- web-push has no
// default of its own here: unset, its underlying https.request never times
// out at all, so one unresponsive push provider (or a stalled TLS
// handshake) could hold this invocation open indefinitely, delaying every
// OTHER subscription queued after it in the same request and, in the
// worst case, the Edge Runtime's own invocation limit. 10 seconds is
// generously long for a normal Web Push provider round trip while still
// bounding the worst case to something that can never meaningfully stack
// up across the handful of devices one notification typically reaches.
// This is a per-attempt bound, NOT retry/backoff -- a timed-out send is
// classified exactly like any other ordinary failure (see
// classifyWebPushError) and is not retried in this phase.
export const PUSH_SEND_TIMEOUT_MS = 10_000;

const EXPIRED_STATUS_CODES: ReadonlySet<number> = new Set([404, 410]);

/**
 * Classifies a thrown error from web-push's sendNotification into the
 * outcome dispatch.ts needs. web-push's WebPushError carries `statusCode`
 * for a non-2xx provider response; 404/410 are the library's own
 * documented signal that the push service considers the subscription
 * permanently gone. Anything else (network failure, other status codes,
 * an error with no statusCode at all) is an ordinary 'failed' -- the
 * subscription is preserved, no retry in this phase.
 */
export function classifyWebPushError(err: unknown): SendPushResult {
  const statusCode = (err as { statusCode?: unknown } | null)?.statusCode;
  const normalizedStatusCode = typeof statusCode === "number"
    ? statusCode
    : undefined;
  const message = err instanceof Error
    ? err.message
    : "Unknown Web Push send failure.";
  if (
    normalizedStatusCode !== undefined &&
    EXPIRED_STATUS_CODES.has(normalizedStatusCode)
  ) {
    return { outcome: "expired", statusCode: normalizedStatusCode };
  }
  return { outcome: "failed", statusCode: normalizedStatusCode, message };
}

/** The exact shape this module needs from web-push's sendNotification --
 *  declared locally since the `web-push` npm package ships no TypeScript
 *  types of its own (an untyped default import resolves to `any`). Also
 *  what dispatch/webPushSender tests substitute a fake for, to prove the
 *  TTL/timeout options actually reach the call, without a real network
 *  request or fighting ESM's lack of a default-export mocking seam. */
type SendNotificationFn = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: { TTL: number; timeout: number },
) => Promise<{ statusCode?: number }>;

export function createWebPushSender(
  vapid: VapidConfig,
  sendNotification: SendNotificationFn = webpush.sendNotification,
): (
  subscription: SubscriptionRow,
  payload: PushPayload,
) => Promise<SendPushResult> {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  return async function sendPush(
    subscription: SubscriptionRow,
    payload: PushPayload,
  ): Promise<SendPushResult> {
    try {
      const result = await sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth_key },
        },
        JSON.stringify(payload),
        { TTL: PUSH_TTL_SECONDS, timeout: PUSH_SEND_TIMEOUT_MS },
      );
      return { outcome: "sent", statusCode: result.statusCode };
    } catch (err) {
      return classifyWebPushError(err);
    }
  };
}
