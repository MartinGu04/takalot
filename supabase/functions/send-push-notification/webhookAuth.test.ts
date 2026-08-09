// Uses Node's built-in assert (via Deno's node: compat layer) rather than
// jsr:@std/assert or deno.land/std -- both are blocked by this
// environment's outbound network policy, and node:assert needs no network
// fetch at all (bundled with the Deno runtime).
import assert from "node:assert/strict";
import { verifyWebhookSecret } from "./webhookAuth.ts";

const SECRET = "test-only-fixture-webhook-secret-value";

Deno.test("verifyWebhookSecret: accepts an exact match", () => {
  assert.equal(verifyWebhookSecret(SECRET, SECRET), true);
});

Deno.test("verifyWebhookSecret: A. rejects a missing header (null)", () => {
  assert.equal(verifyWebhookSecret(null, SECRET), false);
});

Deno.test("verifyWebhookSecret: A. rejects an absent header (undefined)", () => {
  assert.equal(verifyWebhookSecret(undefined, SECRET), false);
});

Deno.test("verifyWebhookSecret: A. rejects an empty-string header", () => {
  assert.equal(verifyWebhookSecret("", SECRET), false);
});

Deno.test("verifyWebhookSecret: B. rejects an incorrect secret of the same length", () => {
  const wrong = SECRET.slice(0, -1) + "X";
  assert.equal(verifyWebhookSecret(wrong, SECRET), false);
});

Deno.test("verifyWebhookSecret: B. rejects an incorrect secret of a different length", () => {
  assert.equal(verifyWebhookSecret("short", SECRET), false);
  assert.equal(verifyWebhookSecret(SECRET + "trailing-extra", SECRET), false);
});

Deno.test("verifyWebhookSecret: rejects when no secret is configured at all (undefined expected)", () => {
  assert.equal(verifyWebhookSecret(SECRET, undefined), false);
});

Deno.test("verifyWebhookSecret: rejects when the configured secret is blank", () => {
  assert.equal(verifyWebhookSecret(SECRET, ""), false);
});

Deno.test("verifyWebhookSecret: never throws on unusual input", () => {
  assert.equal(verifyWebhookSecret(" binary-ish", SECRET), false);
});
