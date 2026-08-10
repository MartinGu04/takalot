// Shared types for the send-push-notification Edge Function. Kept
// dependency-free (no supabase-js/web-push imports) so dispatch.ts stays
// importable from tests without pulling in any real I/O.

/** The subset of public.notifications this function ever reads -- never
 *  notifications.text, which must never reach the outgoing Push payload. */
export interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  category: "action_required" | "update";
  incident_id: string | null;
  /** The profile that caused this notification (migration 0056), when
   *  known -- null for legacy rows and any notification-producing path
   *  that predates that migration. Never the recipient (user_id). */
  actor_id: string | null;
  /** Resolved and stamped once at INSERT time (migration 0058) -- always
   *  true for category "action_required" (mandatory, unconditional). For
   *  category "update", the recipient's resolved per-event Push preference
   *  at the moment this row was created (see
   *  resolve_operational_notification_prefs/notify_operational_recipients
   *  in migration 0058) -- NOT re-evaluated here. Replaces the old
   *  hardcoded `type === "incident_opened"` rule in qualifiesForPush. */
  push_eligible: boolean;
}

/** The subset of public.push_subscriptions this function ever reads.
 *  p256dh/auth are cryptographic material -- see dispatch.ts and index.ts
 *  for the rule that neither is ever logged or returned in a response. */
export interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
}

/** The exact, minimal payload the Service Worker (Phase 3, src/sw.ts /
 *  src/pwa/pushPayload.ts) expects -- title/body/incidentId only. */
export interface PushPayload {
  title: string;
  body: string;
  incidentId: string;
}

export type SendPushResult =
  | { outcome: "sent"; statusCode?: number }
  /** The push provider definitively said this subscription is gone (the
   *  library's own 404/410-equivalent signal) -- remove it server-side. */
  | { outcome: "expired"; statusCode?: number }
  /** Any other failure (network, transient provider error, malformed
   *  response) -- keep the subscription, record the failure, no retry. */
  | { outcome: "failed"; statusCode?: number; message: string };

export type SubscriptionOutcome = "sent" | "failed" | "expired" | "duplicate";

/**
 * Everything handleDispatch needs, injected -- see index.ts for the real
 * (Supabase service-role client + web-push) wiring and dispatch.test.ts for
 * fake implementations. No implementation of this interface may ever throw
 * out of handleDispatch's control -- each is awaited inside a try/catch
 * that degrades to a 'failed' outcome for that one subscription, never
 * aborting the others (see processSubscription in dispatch.ts).
 */
export interface DispatchDeps {
  /** True only when both VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT
   *  are present and shaped correctly -- checked once by the caller (real
   *  wiring: at module load from Deno.env; tests: a fixed fake). */
  vapidConfigured: boolean;
  fetchNotification: (id: string) => Promise<NotificationRow | null>;
  isRecipientActive: (userId: string) => Promise<boolean>;
  /** The actor's canonical display name (profiles.full_name) ONLY -- never
   *  email, never any other field. Returns null when the profile is
   *  missing or its full_name is blank; the caller (dispatch.ts) treats
   *  that identically to "no actor_id at all" -- fall back to the
   *  existing no-suffix copy, never fail/delay/suppress the Push. */
  fetchActorDisplayName: (actorId: string) => Promise<string | null>;
  fetchSubscriptions: (userId: string) => Promise<SubscriptionRow[]>;
  /** Attempts the atomic (notification_id, subscription_id) claim via the
   *  push_deliveries unique constraint (migration 0053). Returns true when
   *  THIS call created the row (owns the send attempt), false on a
   *  uniqueness conflict (someone already claimed it -- do not send). */
  claimDelivery: (
    notificationId: string,
    subscriptionId: string,
  ) => Promise<boolean>;
  markDeliverySent: (
    notificationId: string,
    subscriptionId: string,
    httpStatus?: number,
  ) => Promise<void>;
  /** status = 'failed' (migration 0053) -- an ordinary send failure. The
   *  subscription is preserved; no retry is attempted in this phase. */
  markDeliveryFailed: (
    notificationId: string,
    subscriptionId: string,
    errorMessage: string,
    httpStatus?: number,
  ) => Promise<void>;
  /** status = 'expired' (migration 0053) -- distinct from 'failed': the
   *  provider definitively said this subscription is gone. Always paired
   *  with removeSubscription by the caller (see dispatch.ts). */
  markDeliveryExpired: (
    notificationId: string,
    subscriptionId: string,
    httpStatus?: number,
  ) => Promise<void>;
  removeSubscription: (subscriptionId: string) => Promise<void>;
  sendPush: (
    subscription: SubscriptionRow,
    payload: PushPayload,
  ) => Promise<SendPushResult>;
}

export interface DispatchRequest {
  /** The raw `x-avaria-push-secret` header value, or null if absent. */
  secretHeader: string | null;
  /** The parsed JSON request body (or null/undefined if parsing failed
   *  upstream) -- handleDispatch validates its shape itself. */
  body: unknown;
}

export interface DispatchOutcome {
  status: number;
  body: {
    result: "unauthorized" | "bad_request" | "not_found" | "skipped" | "ok";
    reason?: string;
    attempted?: number;
    sent?: number;
    failed?: number;
    expired?: number;
    duplicate?: number;
  };
}
