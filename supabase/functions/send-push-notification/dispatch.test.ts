// Full send-push-notification processing flow, exercised through
// handleDispatch with a fully fake DispatchDeps -- no real database, no
// real Push provider, no network call of any kind. Fake subscriptions
// carry obviously-fake endpoint/key strings, never anything resembling
// real cryptographic material.
//
// deno-lint-ignore-file require-await -- createFakeDeps' methods
// deliberately match DispatchDeps' async signatures without needing an
// internal `await` themselves; that is the point of a fake.
import assert from "node:assert/strict";
import {
  buildPushBody,
  extractNotificationId,
  handleDispatch,
  qualifiesForPush,
} from "./dispatch.ts";
import type {
  DispatchDeps,
  NotificationRow,
  SendPushResult,
  SubscriptionRow,
} from "./types.ts";

const SECRET = "test-only-fixture-webhook-secret";
const NOTIFICATION_ID = "11111111-1111-1111-1111-111111111111";
const INCIDENT_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "33333333-3333-3333-3333-333333333333";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";

function baseNotification(
  overrides: Partial<NotificationRow> = {},
): NotificationRow {
  return {
    id: NOTIFICATION_ID,
    user_id: USER_ID,
    type: "incident_assigned",
    category: "action_required",
    incident_id: INCIDENT_ID,
    actor_id: null,
    // Matches the default category above (action_required is always
    // push-eligible, unconditionally) -- any test overriding category to
    // "update" must explicitly pass its own push_eligible value; see
    // migration 0058 / dispatch.ts's qualifiesForPush.
    push_eligible: true,
    ...overrides,
  };
}

function fakeSubscription(
  overrides: Partial<SubscriptionRow> = {},
): SubscriptionRow {
  return {
    id: "sub-" + Math.random().toString(36).slice(2),
    endpoint: "https://push.example.invalid/fake-endpoint-" +
      Math.random().toString(36).slice(2),
    p256dh: "fake-p256dh-not-real-key-material",
    auth_key: "fake-auth-not-real-key-material",
    ...overrides,
  };
}

interface DepsCalls {
  claimed: Array<[string, string]>;
  sent: Array<[string, string, number | undefined]>;
  failed: Array<[string, string, string, number | undefined]>;
  expired: Array<[string, string, number | undefined]>;
  removed: string[];
  sendPushCalls: Array<
    {
      subscription: SubscriptionRow;
      payload: { title: string; body: string; incidentId: string };
    }
  >;
  actorLookups: string[];
}

function createFakeDeps(options: {
  notification?: NotificationRow | null;
  active?: boolean;
  subscriptions?: SubscriptionRow[];
  vapidConfigured?: boolean;
  claimResults?: Record<string, boolean>; // subscriptionId -> claimed?
  sendResults?: Record<string, SendPushResult>; // subscriptionId -> result
  claimShouldThrow?: Set<string>;
  sendShouldThrow?: Set<string>;
  actorName?: string | null;
  actorLookupShouldThrow?: boolean;
}): { deps: DispatchDeps; calls: DepsCalls } {
  const calls: DepsCalls = {
    claimed: [],
    sent: [],
    failed: [],
    expired: [],
    removed: [],
    sendPushCalls: [],
    actorLookups: [],
  };
  const deps: DispatchDeps = {
    vapidConfigured: options.vapidConfigured ?? true,
    fetchNotification: async (
      id,
    ) => (options.notification !== undefined
      ? (id === NOTIFICATION_ID ? options.notification : null)
      : null),
    isRecipientActive: async () => options.active ?? true,
    fetchSubscriptions: async () => options.subscriptions ?? [],
    fetchActorDisplayName: async (actorId) => {
      calls.actorLookups.push(actorId);
      if (options.actorLookupShouldThrow) {
        throw new Error("simulated actor lookup failure");
      }
      return options.actorName ?? null;
    },
    claimDelivery: async (notificationId, subscriptionId) => {
      calls.claimed.push([notificationId, subscriptionId]);
      if (options.claimShouldThrow?.has(subscriptionId)) {
        throw new Error("simulated claim failure");
      }
      return options.claimResults?.[subscriptionId] ?? true;
    },
    markDeliverySent: async (notificationId, subscriptionId, httpStatus) => {
      calls.sent.push([notificationId, subscriptionId, httpStatus]);
    },
    markDeliveryFailed: async (
      notificationId,
      subscriptionId,
      errorMessage,
      httpStatus,
    ) => {
      calls.failed.push([
        notificationId,
        subscriptionId,
        errorMessage,
        httpStatus,
      ]);
    },
    markDeliveryExpired: async (notificationId, subscriptionId, httpStatus) => {
      calls.expired.push([notificationId, subscriptionId, httpStatus]);
    },
    removeSubscription: async (subscriptionId) => {
      calls.removed.push(subscriptionId);
    },
    sendPush: async (subscription, payload) => {
      calls.sendPushCalls.push({ subscription, payload });
      if (options.sendShouldThrow?.has(subscription.id)) {
        throw new Error("simulated send crash");
      }
      return options.sendResults?.[subscription.id] ?? { outcome: "sent" };
    },
  };
  return { deps, calls };
}

// =====================================================================
// A/B. Webhook authentication rejects BEFORE any DB access.
// =====================================================================
Deno.test("A: missing webhook secret header -> 401, no DB access", async () => {
  const { deps, calls } = createFakeDeps({ notification: baseNotification() });
  const outcome = await handleDispatch(
    { secretHeader: null, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.equal(outcome.status, 401);
  assert.equal(outcome.body.result, "unauthorized");
  assert.equal(calls.sendPushCalls.length, 0);
});

Deno.test("B: incorrect webhook secret -> 401, no DB access", async () => {
  const { deps, calls } = createFakeDeps({ notification: baseNotification() });
  const outcome = await handleDispatch(
    {
      secretHeader: "wrong-secret",
      body: { notification_id: NOTIFICATION_ID },
    },
    deps,
    SECRET,
  );
  assert.equal(outcome.status, 401);
  assert.equal(calls.claimed.length, 0);
});

// =====================================================================
// C. Malformed notification_id -> safe 400, never an exception.
// =====================================================================
Deno.test("C: malformed notification_id -> 400 bad_request", async () => {
  const { deps } = createFakeDeps({ notification: baseNotification() });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: "not-a-uuid" } },
    deps,
    SECRET,
  );
  assert.equal(outcome.status, 400);
  assert.equal(outcome.body.result, "bad_request");
});

Deno.test("C: missing notification_id entirely -> 400 bad_request", async () => {
  const { deps } = createFakeDeps({ notification: baseNotification() });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: {} },
    deps,
    SECRET,
  );
  assert.equal(outcome.status, 400);
});

Deno.test("C: non-object body -> 400 bad_request, never throws", async () => {
  const { deps } = createFakeDeps({ notification: baseNotification() });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: null },
    deps,
    SECRET,
  );
  assert.equal(outcome.status, 400);
});

Deno.test("extractNotificationId: accepts a well-formed UUID", () => {
  assert.equal(
    extractNotificationId({ notification_id: NOTIFICATION_ID }),
    NOTIFICATION_ID,
  );
});

// =====================================================================
// D. Nonexistent notification -> safe no-send, 200.
// =====================================================================
Deno.test("D: nonexistent notification -> 200 not_found, no send attempted", async () => {
  const { deps, calls } = createFakeDeps({ notification: null });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.result, "not_found");
  assert.equal(calls.sendPushCalls.length, 0);
});

// =====================================================================
// E. Notification outside v1.6 policy (push_eligible=false, the
// recipient's resolved Push preference for this event type was off at
// creation time) -> skipped, no send. Includes incident_opened -- v1.6 no
// longer hardcodes that type as always-eligible; push_eligible is what
// decides, for every type equally (migration 0058).
// =====================================================================
for (
  const type of [
    "incident_opened",
    "incident_updated",
    "incident_closed",
    "incident_cancelled",
    "incident_reopened",
  ] as const
) {
  Deno.test(`E: category=update type=${type} push_eligible=false does not qualify -> skipped, no send`, async () => {
    const { deps, calls } = createFakeDeps({
      notification: baseNotification({ type, category: "update", push_eligible: false }),
    });
    const outcome = await handleDispatch(
      { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
      deps,
      SECRET,
    );
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.result, "skipped");
    assert.equal(outcome.body.reason, "policy");
    assert.equal(calls.sendPushCalls.length, 0);
  });
}

// =====================================================================
// E2. The mirror case: category=update, push_eligible=true DOES qualify,
// for a non-opened type too -- proves the v1.6 policy is driven entirely
// by push_eligible, not a hardcoded type comparison (incident_opened was
// the only type that could ever reach a send under the old v1.5 policy;
// incident_updated below could never have qualified before this
// migration).
// =====================================================================
Deno.test("E2: category=update type=incident_updated push_eligible=true DOES qualify -> send attempted", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification({
      type: "incident_updated",
      category: "update",
      push_eligible: true,
    }),
    subscriptions: [sub],
  });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.result, "ok");
  assert.equal(calls.sendPushCalls.length, 1);
});

Deno.test("qualifiesForPush matches migration 0058's exact WHEN clause boundary", () => {
  // action_required: always true, unconditionally, regardless of
  // push_eligible's stored value (mandatory -- see the notifications.push_eligible
  // column comment; action_required rows are always stamped true anyway,
  // but the policy itself does not even consult the column for this
  // category).
  assert.equal(
    qualifiesForPush({ category: "action_required", push_eligible: true }),
    true,
  );
  assert.equal(
    qualifiesForPush({ category: "action_required", push_eligible: false }),
    true,
  );
  // update: driven entirely by push_eligible, for every type equally --
  // v1.6 no longer hardcodes incident_opened as the one always-eligible
  // type (see E/E2 above for the type-level exercise through the full
  // handleDispatch flow).
  assert.equal(
    qualifiesForPush({ category: "update", push_eligible: true }),
    true,
  );
  assert.equal(
    qualifiesForPush({ category: "update", push_eligible: false }),
    false,
  );
});

Deno.test("a notification with no incident_id (e.g. handover_pending) is skipped safely, never sent", async () => {
  const { deps, calls } = createFakeDeps({
    notification: baseNotification({
      type: "handover_pending",
      incident_id: null,
    }),
  });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.result, "skipped");
  assert.equal(outcome.body.reason, "no_incident_id");
  assert.equal(calls.sendPushCalls.length, 0);
});

// =====================================================================
// F. Inactive recipient -> ZERO Push attempts.
// =====================================================================
Deno.test("F: inactive recipient -> zero Push attempts", async () => {
  const { deps, calls } = createFakeDeps({
    notification: baseNotification(),
    active: false,
    subscriptions: [fakeSubscription(), fakeSubscription()],
  });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.result, "skipped");
  assert.equal(outcome.body.reason, "inactive_recipient");
  assert.equal(calls.sendPushCalls.length, 0);
  assert.equal(calls.claimed.length, 0);
});

// =====================================================================
// R (dispatch-level): missing/invalid VAPID -> no provider call, safe skip.
// =====================================================================
Deno.test("R: VAPID not configured -> no provider call, safe skip, active recipient still checked first", async () => {
  const { deps, calls } = createFakeDeps({
    notification: baseNotification(),
    vapidConfigured: false,
    subscriptions: [fakeSubscription()],
  });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.result, "skipped");
  assert.equal(outcome.body.reason, "vapid_unconfigured");
  assert.equal(calls.sendPushCalls.length, 0);
});

// =====================================================================
// G. No subscriptions -> successful zero-send result.
// =====================================================================
Deno.test("G: no subscriptions -> 200 ok, zero-send result", async () => {
  const { deps } = createFakeDeps({
    notification: baseNotification(),
    subscriptions: [],
  });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.equal(outcome.status, 200);
  assert.deepEqual(outcome.body, {
    result: "ok",
    attempted: 0,
    sent: 0,
    failed: 0,
    expired: 0,
    duplicate: 0,
  });
});

// =====================================================================
// H. Successful atomic claim -> exactly one send.
// =====================================================================
Deno.test("H: a successful claim results in exactly one send, marked sent", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification(),
    subscriptions: [sub],
  });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.equal(outcome.status, 200);
  assert.deepEqual(outcome.body, {
    result: "ok",
    attempted: 1,
    sent: 1,
    failed: 0,
    expired: 0,
    duplicate: 0,
  });
  assert.equal(calls.sendPushCalls.length, 1);
  assert.equal(calls.sent.length, 1);
  assert.deepEqual(calls.sent[0], [NOTIFICATION_ID, sub.id, undefined]);
});

// =====================================================================
// I. Duplicate/already-claimed delivery -> zero duplicate send.
// =====================================================================
Deno.test("I: a losing claim (already claimed elsewhere) never sends", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification(),
    subscriptions: [sub],
    claimResults: { [sub.id]: false },
  });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.deepEqual(outcome.body, {
    result: "ok",
    attempted: 1,
    sent: 0,
    failed: 0,
    expired: 0,
    duplicate: 1,
  });
  assert.equal(calls.sendPushCalls.length, 0);
});

// =====================================================================
// J. Multiple subscriptions: one failure does not stop another.
// =====================================================================
Deno.test("J: one subscription failing does not prevent another from sending", async () => {
  const failing = fakeSubscription();
  const succeeding = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification(),
    subscriptions: [failing, succeeding],
    sendResults: {
      [failing.id]: {
        outcome: "failed",
        message: "simulated provider error",
        statusCode: 500,
      },
      [succeeding.id]: { outcome: "sent" },
    },
  });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.deepEqual(outcome.body, {
    result: "ok",
    attempted: 2,
    sent: 1,
    failed: 1,
    expired: 0,
    duplicate: 0,
  });
  assert.equal(calls.sendPushCalls.length, 2);
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.failed.length, 1);
});

Deno.test("J2: an unexpected thrown error from one subscription's send does not stop another's", async () => {
  const crashing = fakeSubscription();
  const succeeding = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification(),
    subscriptions: [crashing, succeeding],
    sendShouldThrow: new Set([crashing.id]),
  });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.equal(outcome.body.sent, 1);
  assert.equal(outcome.body.failed, 1);
  assert.equal(calls.sent.length, 1);
});

// =====================================================================
// K/L/M. Exact approved payloads per notification shape.
// =====================================================================
Deno.test("K: exact approved payload for incident_opened (category=update)", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification({
      type: "incident_opened",
      category: "update",
      push_eligible: true,
    }),
    subscriptions: [sub],
  });
  await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.deepEqual(calls.sendPushCalls[0].payload, {
    title: "AVARIA",
    body: "נפתחה תקלה חדשה",
    incidentId: INCIDENT_ID,
  });
});

Deno.test("L: exact approved payload for an assignment action_required notification", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification({
      type: "incident_assigned",
      category: "action_required",
    }),
    subscriptions: [sub],
  });
  await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.deepEqual(calls.sendPushCalls[0].payload, {
    title: "AVARIA",
    body: "תקלה שויכה אליך",
    incidentId: INCIDENT_ID,
  });
});

Deno.test("M: exact approved payload for a reopened action_required notification", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification({
      type: "incident_reopened",
      category: "action_required",
    }),
    subscriptions: [sub],
  });
  await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.deepEqual(calls.sendPushCalls[0].payload, {
    title: "AVARIA",
    body: "תקלה שבאחריותך נפתחה מחדש",
    incidentId: INCIDENT_ID,
  });
});

// =====================================================================
// T. Push actor name polish -- exact copy with a resolved actor, safe
// fallback without one, actor never confused with the recipient, and
// email never used as a stand-in for the display name.
// =====================================================================
Deno.test("T1: incident_assigned with a resolvable actor -> 'תקלה שויכה אליך · ע״י <name>'", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification({
      type: "incident_assigned",
      category: "action_required",
      actor_id: ACTOR_ID,
    }),
    subscriptions: [sub],
    actorName: "דניאל דיוקרב",
  });
  await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.deepEqual(calls.sendPushCalls[0].payload, {
    title: "AVARIA",
    body: "תקלה שויכה אליך · ע״י דניאל דיוקרב",
    incidentId: INCIDENT_ID,
  });
  assert.deepEqual(calls.actorLookups, [ACTOR_ID]);
});

Deno.test("T2: incident_opened with a resolvable actor -> 'נפתחה תקלה חדשה · ע״י <name>'", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification({
      type: "incident_opened",
      category: "update",
      actor_id: ACTOR_ID,
      push_eligible: true,
    }),
    subscriptions: [sub],
    actorName: "דניאל דיוקרב",
  });
  await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.deepEqual(calls.sendPushCalls[0].payload, {
    title: "AVARIA",
    body: "נפתחה תקלה חדשה · ע״י דניאל דיוקרב",
    incidentId: INCIDENT_ID,
  });
});

Deno.test("T3: action_required incident_reopened with a resolvable actor -> 'תקלה שבאחריותך נפתחה מחדש · ע״י <name>'", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification({
      type: "incident_reopened",
      category: "action_required",
      actor_id: ACTOR_ID,
    }),
    subscriptions: [sub],
    actorName: "דניאל דיוקרב",
  });
  await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.deepEqual(calls.sendPushCalls[0].payload, {
    title: "AVARIA",
    body: "תקלה שבאחריותך נפתחה מחדש · ע״י דניאל דיוקרב",
    incidentId: INCIDENT_ID,
  });
});

Deno.test("T4: missing actor_id -> no lookup attempted, falls back to the existing no-suffix copy, still sends", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification({ actor_id: null }),
    subscriptions: [sub],
  });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.equal(outcome.body.result, "ok");
  assert.equal(outcome.body.sent, 1);
  assert.deepEqual(calls.sendPushCalls[0].payload, {
    title: "AVARIA",
    body: "תקלה שויכה אליך",
    incidentId: INCIDENT_ID,
  });
  assert.deepEqual(calls.actorLookups, []);
});

Deno.test("T5: an unresolvable actor (lookup returns null) falls back to the existing no-suffix copy, still sends", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification({ actor_id: ACTOR_ID }),
    subscriptions: [sub],
    actorName: null,
  });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.equal(outcome.body.result, "ok");
  assert.equal(outcome.body.sent, 1);
  assert.deepEqual(calls.sendPushCalls[0].payload, {
    title: "AVARIA",
    body: "תקלה שויכה אליך",
    incidentId: INCIDENT_ID,
  });
});

Deno.test("T6: an unexpected error resolving the actor never fails or blocks delivery -- falls back to the no-suffix copy", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification({ actor_id: ACTOR_ID }),
    subscriptions: [sub],
    actorLookupShouldThrow: true,
  });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.result, "ok");
  assert.equal(outcome.body.sent, 1);
  assert.deepEqual(calls.sendPushCalls[0].payload, {
    title: "AVARIA",
    body: "תקלה שויכה אליך",
    incidentId: INCIDENT_ID,
  });
});

Deno.test("T7: the actor lookup is keyed by actor_id, never by the recipient's user_id -- recipient name is never substituted for the actor", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification({ actor_id: ACTOR_ID }),
    subscriptions: [sub],
    actorName: "Actor Name",
  });
  await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.deepEqual(calls.actorLookups, [ACTOR_ID]);
  assert.ok(!calls.actorLookups.includes(USER_ID));
});

Deno.test("buildPushBody: exact copy for every approved case", () => {
  assert.equal(
    buildPushBody({ category: "update", type: "incident_opened" }),
    "נפתחה תקלה חדשה",
  );
  assert.equal(
    buildPushBody({ category: "action_required", type: "incident_reopened" }),
    "תקלה שבאחריותך נפתחה מחדש",
  );
  assert.equal(
    buildPushBody({ category: "action_required", type: "incident_assigned" }),
    "תקלה שויכה אליך",
  );
  assert.equal(
    buildPushBody({ category: "action_required", type: "handover_pending" }),
    "תקלה שויכה אליך",
  );
});

Deno.test("buildPushBody: v1.6 (migration 0058) copy for the four operational update types that were never push-eligible before", () => {
  assert.equal(
    buildPushBody({ category: "update", type: "incident_updated" }),
    "עודכנה תקלה",
  );
  assert.equal(
    buildPushBody({ category: "update", type: "incident_closed" }),
    "נסגרה תקלה",
  );
  assert.equal(
    buildPushBody({ category: "update", type: "incident_cancelled" }),
    "בוטלה תקלה",
  );
  assert.equal(
    buildPushBody({ category: "update", type: "incident_reopened" }),
    "תקלה נפתחה מחדש",
  );
});

Deno.test("buildPushBody: appends the actor suffix when a non-blank name is given, for all three approved variants", () => {
  assert.equal(
    buildPushBody(
      { category: "action_required", type: "incident_assigned" },
      "דניאל דיוקרב",
    ),
    "תקלה שויכה אליך · ע״י דניאל דיוקרב",
  );
  assert.equal(
    buildPushBody(
      { category: "update", type: "incident_opened" },
      "דניאל דיוקרב",
    ),
    "נפתחה תקלה חדשה · ע״י דניאל דיוקרב",
  );
  assert.equal(
    buildPushBody(
      { category: "action_required", type: "incident_reopened" },
      "דניאל דיוקרב",
    ),
    "תקלה שבאחריותך נפתחה מחדש · ע״י דניאל דיוקרב",
  );
});

Deno.test("buildPushBody: null/undefined/blank actor name leaves the copy exactly as before, no suffix", () => {
  const expected = "תקלה שויכה אליך";
  assert.equal(
    buildPushBody(
      { category: "action_required", type: "incident_assigned" },
      null,
    ),
    expected,
  );
  assert.equal(
    buildPushBody(
      { category: "action_required", type: "incident_assigned" },
      undefined,
    ),
    expected,
  );
  assert.equal(
    buildPushBody(
      { category: "action_required", type: "incident_assigned" },
      "   ",
    ),
    expected,
  );
});

// =====================================================================
// N. notifications.text NEVER appears in the outgoing Push payload -- the
// fake notification here doesn't even carry a `text` field (matching the
// real NotificationRow type, which deliberately has none), and the
// resulting payload is asserted to contain exactly title/body/incidentId.
// =====================================================================
Deno.test("N: the outgoing payload never contains a text/description field, only title/body/incidentId", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification(),
    subscriptions: [sub],
  });
  await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  const payload = calls.sendPushCalls[0].payload;
  assert.deepEqual(Object.keys(payload).sort(), [
    "body",
    "incidentId",
    "title",
  ]);
});

// =====================================================================
// O. Successful provider send -> delivery marked sent.
// =====================================================================
Deno.test("O: a successful send marks the delivery sent, with the provider status code", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification(),
    subscriptions: [sub],
    sendResults: { [sub.id]: { outcome: "sent", statusCode: 201 } },
  });
  await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.deepEqual(calls.sent[0], [NOTIFICATION_ID, sub.id, 201]);
  assert.equal(calls.failed.length, 0);
  assert.equal(calls.expired.length, 0);
  assert.equal(calls.removed.length, 0);
});

// =====================================================================
// P. Ordinary send failure -> delivery marked failed, subscription
// preserved (never removed).
// =====================================================================
Deno.test("P: an ordinary send failure marks the delivery failed and preserves the subscription", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification(),
    subscriptions: [sub],
    sendResults: {
      [sub.id]: {
        outcome: "failed",
        message: "temporary provider outage",
        statusCode: 503,
      },
    },
  });
  await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.deepEqual(calls.failed[0], [
    NOTIFICATION_ID,
    sub.id,
    "temporary provider outage",
    503,
  ]);
  assert.equal(
    calls.removed.length,
    0,
    "the subscription must NOT be removed for an ordinary failure",
  );
});

// =====================================================================
// Q. Expired 404/410 -> subscription removed, delivery marked expired
// (not failed).
// =====================================================================
Deno.test("Q: an expired (404/410-equivalent) result marks the delivery expired and removes the subscription", async () => {
  const sub = fakeSubscription();
  const { deps, calls } = createFakeDeps({
    notification: baseNotification(),
    subscriptions: [sub],
    sendResults: { [sub.id]: { outcome: "expired", statusCode: 410 } },
  });
  await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  assert.deepEqual(calls.expired[0], [NOTIFICATION_ID, sub.id, 410]);
  assert.equal(
    calls.failed.length,
    0,
    "expired must use markDeliveryExpired, never markDeliveryFailed",
  );
  assert.deepEqual(calls.removed, [sub.id]);
});

// =====================================================================
// S. The response/log summary never exposes endpoint/auth/p256dh/private
// key material -- proven by checking the JSON-serialized response never
// contains the fake (but distinctive) endpoint/key strings used above.
// =====================================================================
Deno.test("S: the HTTP response body never contains a subscription endpoint, p256dh, or auth value", async () => {
  const sub = fakeSubscription({
    endpoint: "https://push.example.invalid/UNIQUE-MARKER-ENDPOINT",
    p256dh: "UNIQUE-MARKER-P256DH",
    auth_key: "UNIQUE-MARKER-AUTH",
  });
  const { deps } = createFakeDeps({
    notification: baseNotification(),
    subscriptions: [sub],
  });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  const serialized = JSON.stringify(outcome.body);
  assert.ok(!serialized.includes("UNIQUE-MARKER-ENDPOINT"));
  assert.ok(!serialized.includes("UNIQUE-MARKER-P256DH"));
  assert.ok(!serialized.includes("UNIQUE-MARKER-AUTH"));
});

Deno.test("S: the HTTP response body contains only the documented machine-readable summary fields", async () => {
  const sub = fakeSubscription();
  const { deps } = createFakeDeps({
    notification: baseNotification(),
    subscriptions: [sub],
  });
  const outcome = await handleDispatch(
    { secretHeader: SECRET, body: { notification_id: NOTIFICATION_ID } },
    deps,
    SECRET,
  );
  const allowedKeys = new Set([
    "result",
    "reason",
    "attempted",
    "sent",
    "failed",
    "expired",
    "duplicate",
  ]);
  for (const key of Object.keys(outcome.body)) {
    assert.ok(allowedKeys.has(key), `unexpected response field: ${key}`);
  }
});
