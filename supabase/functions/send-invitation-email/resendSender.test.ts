import assert from "node:assert/strict";
import { createResendSender } from "./resendSender.ts";

const EMAIL = { to: "a@example.com", subject: "s", html: "<p>h</p>", text: "t" };
const CONFIG = { apiKey: "test-key", fromAddress: "AVARIA <invitations@example.com>" };

function fakeFetch(response: { ok: boolean; status: number; text: string }): typeof fetch {
  return (async () =>
    new Response(response.text, { status: response.status })) as unknown as typeof fetch;
}

Deno.test("createResendSender: a 2xx response reports outcome 'sent'", async () => {
  const send = createResendSender(CONFIG, fakeFetch({ ok: true, status: 200, text: "{}" }));
  const result = await send(EMAIL);
  assert.deepEqual(result, { outcome: "sent" });
});

Deno.test("createResendSender: sends the expected request shape", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const capturingFetch = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const send = createResendSender(CONFIG, capturingFetch);
  await send(EMAIL);
  assert.ok(captured);
  const { url, init } = captured!;
  assert.equal(url, "https://api.resend.com/emails");
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer test-key");
  const body = JSON.parse(init.body as string);
  assert.deepEqual(body, {
    from: CONFIG.fromAddress,
    to: [EMAIL.to],
    subject: EMAIL.subject,
    html: EMAIL.html,
    text: EMAIL.text,
  });
});

Deno.test("createResendSender: a 401/403 response reports a safe 'misconfigured' message, not the raw body", async () => {
  const send = createResendSender(
    CONFIG,
    fakeFetch({ ok: false, status: 401, text: "raw provider secret detail" }),
  );
  const result = await send(EMAIL);
  assert.equal(result.outcome, "failed");
  assert.ok(result.message && !result.message.includes("raw provider secret detail"));
});

Deno.test("createResendSender: a generic 5xx response reports a safe generic failure message", async () => {
  const send = createResendSender(CONFIG, fakeFetch({ ok: false, status: 500, text: "internal provider error" }));
  const result = await send(EMAIL);
  assert.equal(result.outcome, "failed");
  assert.ok(result.message && !result.message.includes("internal provider error"));
});

Deno.test("createResendSender: a network-level throw is reported as a failure, never propagated", async () => {
  const throwingFetch = (() => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const send = createResendSender(CONFIG, throwingFetch);
  const result = await send(EMAIL);
  assert.equal(result.outcome, "failed");
  assert.ok(result.message);
});
