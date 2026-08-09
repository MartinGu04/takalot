// Tests classifyWebPushError and createWebPushSender's outgoing send
// options -- no real Web Push provider is ever contacted. classifyWebPushError
// tests use plain fake Error objects shaped like web-push's own
// WebPushError (a `statusCode` property); createWebPushSender's tests
// inject a fake sendNotification function (see its own SendNotificationFn
// parameter) that only records what it was called with.
import assert from "node:assert/strict";
import {
  classifyWebPushError,
  createWebPushSender,
  PUSH_SEND_TIMEOUT_MS,
  PUSH_TTL_SECONDS,
} from "./webPushSender.ts";

const FAKE_VAPID = {
  publicKey:
    "BNseZOIZ0F533y9gawBdsP4XDCpc4b01ZmSt7COKSQ57zpuChRuIFzjoU_8XUg5XOw2NrrxuUtUp9QklU-Hsnik",
  privateKey: "ZmFrZS10ZXN0LW9ubHktcHJpdmF0ZS1rZXktdmFsdWU",
  subject: "mailto:push-test@example.invalid",
};

const FAKE_SUBSCRIPTION = {
  id: "sub-1",
  endpoint: "https://push.example.invalid/fake-endpoint",
  p256dh: "fake-p256dh-not-real-key-material",
  auth_key: "fake-auth-not-real-key-material",
};

function fakeWebPushError(
  statusCode: number | undefined,
  message = "push service error",
) {
  const err = new Error(message) as Error & { statusCode?: number };
  if (statusCode !== undefined) err.statusCode = statusCode;
  return err;
}

Deno.test("Q: a 404 statusCode classifies as expired", () => {
  const result = classifyWebPushError(fakeWebPushError(404));
  assert.deepEqual(result, { outcome: "expired", statusCode: 404 });
});

Deno.test("Q: a 410 statusCode classifies as expired", () => {
  const result = classifyWebPushError(fakeWebPushError(410));
  assert.deepEqual(result, { outcome: "expired", statusCode: 410 });
});

Deno.test("P: a 500 statusCode classifies as an ordinary failure, not expired", () => {
  const result = classifyWebPushError(
    fakeWebPushError(500, "push service unavailable"),
  );
  assert.equal(result.outcome, "failed");
  if (result.outcome === "failed") {
    assert.equal(result.statusCode, 500);
    assert.equal(result.message, "push service unavailable");
  }
});

Deno.test("P: a 400/413/429 statusCode is also an ordinary failure, never expired", () => {
  for (const status of [400, 413, 429]) {
    const result = classifyWebPushError(fakeWebPushError(status));
    assert.equal(result.outcome, "failed");
  }
});

Deno.test("P: an error with no statusCode at all (e.g. a network failure) is an ordinary failure", () => {
  const result = classifyWebPushError(
    new Error("fetch failed: network unreachable"),
  );
  assert.equal(result.outcome, "failed");
  if (result.outcome === "failed") {
    assert.equal(result.statusCode, undefined);
    assert.equal(result.message, "fetch failed: network unreachable");
  }
});

Deno.test("classifyWebPushError never throws on a non-Error thrown value", () => {
  const result = classifyWebPushError("a plain string, not an Error");
  assert.equal(result.outcome, "failed");
});

Deno.test("PUSH_TTL_SECONDS is a short, explicit, conservative operational TTL (not a multi-day/library default)", () => {
  assert.equal(PUSH_TTL_SECONDS, 3600);
  assert.ok(
    PUSH_TTL_SECONDS <= 4 * 3600,
    "TTL should be a few hours at most for an incident nudge",
  );
});

Deno.test("PUSH_SEND_TIMEOUT_MS is a short, explicit, bounded per-send socket timeout", () => {
  assert.equal(PUSH_SEND_TIMEOUT_MS, 10_000);
  assert.ok(
    PUSH_SEND_TIMEOUT_MS <= 30_000,
    "one send must never be able to hang the invocation for long",
  );
});

Deno.test("createWebPushSender passes both TTL and a bounded timeout to the provider on every send", async () => {
  const calls: Array<
    {
      subscription: unknown;
      payload: string;
      options: { TTL: number; timeout: number };
    }
  > = [];
  const fakeSendNotification = (
    subscription: unknown,
    payload: string,
    options: { TTL: number; timeout: number },
  ) => {
    calls.push({ subscription, payload, options });
    return Promise.resolve({ statusCode: 201 });
  };

  const sendPush = createWebPushSender(FAKE_VAPID, fakeSendNotification);
  await sendPush(FAKE_SUBSCRIPTION, {
    title: "AVARIA",
    body: "test",
    incidentId: "inc-1",
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, {
    TTL: PUSH_TTL_SECONDS,
    timeout: PUSH_SEND_TIMEOUT_MS,
  });
});

Deno.test("createWebPushSender: a socket-timeout-shaped rejection from the provider classifies as an ordinary failure, not expired", async () => {
  const timeoutError = new Error("Socket timeout");
  const fakeSendNotification = () => Promise.reject(timeoutError);

  const sendPush = createWebPushSender(FAKE_VAPID, fakeSendNotification);
  const result = await sendPush(FAKE_SUBSCRIPTION, {
    title: "AVARIA",
    body: "test",
    incidentId: "inc-1",
  });

  assert.equal(result.outcome, "failed");
  if (result.outcome === "failed") {
    assert.equal(result.message, "Socket timeout");
    assert.equal(result.statusCode, undefined);
  }
});
