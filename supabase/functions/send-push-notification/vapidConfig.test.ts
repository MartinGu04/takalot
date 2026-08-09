import assert from "node:assert/strict";
import { resolveVapidConfig } from "./vapidConfig.ts";

// A real-shaped VAPID public key: 65 raw bytes (0x04 prefix + 32+32-byte EC
// point), base64url-encoded. Randomly generated for this test only -- not
// a real credential, and never resembles one (see the module comment for
// why real values must never appear in source/tests).
const FAKE_VALID_PUBLIC_KEY =
  "BNseZOIZ0F533y9gawBdsP4XDCpc4b01ZmSt7COKSQ57zpuChRuIFzjoU_8XUg5XOw2NrrxuUtUp9QklU-Hsnik";
const FAKE_PRIVATE_KEY = "ZmFrZS10ZXN0LW9ubHktcHJpdmF0ZS1rZXktdmFsdWU"; // obviously-fake fixture, not real key material
const FAKE_SUBJECT = "mailto:push-test@example.invalid";

function envFrom(
  vars: Record<string, string | undefined>,
): (name: string) => string | undefined {
  return (name) => vars[name];
}

Deno.test("resolveVapidConfig: accepts a fully valid configuration", () => {
  const config = resolveVapidConfig(
    envFrom({
      VAPID_PUBLIC_KEY: FAKE_VALID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: FAKE_PRIVATE_KEY,
      VAPID_SUBJECT: FAKE_SUBJECT,
    }),
  );
  assert.deepEqual(config, {
    publicKey: FAKE_VALID_PUBLIC_KEY,
    privateKey: FAKE_PRIVATE_KEY,
    subject: FAKE_SUBJECT,
  });
});

Deno.test("resolveVapidConfig: accepts an https: subject too", () => {
  const config = resolveVapidConfig(
    envFrom({
      VAPID_PUBLIC_KEY: FAKE_VALID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: FAKE_PRIVATE_KEY,
      VAPID_SUBJECT: "https://example.invalid",
    }),
  );
  assert.notEqual(config, null);
});

Deno.test("R: resolveVapidConfig returns null when every variable is entirely unset", () => {
  assert.equal(resolveVapidConfig(envFrom({})), null);
});

Deno.test("R: resolveVapidConfig returns null when only the public key is missing", () => {
  assert.equal(
    resolveVapidConfig(
      envFrom({
        VAPID_PRIVATE_KEY: FAKE_PRIVATE_KEY,
        VAPID_SUBJECT: FAKE_SUBJECT,
      }),
    ),
    null,
  );
});

Deno.test("R: resolveVapidConfig returns null when only the private key is missing", () => {
  assert.equal(
    resolveVapidConfig(
      envFrom({
        VAPID_PUBLIC_KEY: FAKE_VALID_PUBLIC_KEY,
        VAPID_SUBJECT: FAKE_SUBJECT,
      }),
    ),
    null,
  );
});

Deno.test("R: resolveVapidConfig returns null when only the subject is missing", () => {
  assert.equal(
    resolveVapidConfig(
      envFrom({
        VAPID_PUBLIC_KEY: FAKE_VALID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY: FAKE_PRIVATE_KEY,
      }),
    ),
    null,
  );
});

Deno.test("R: resolveVapidConfig returns null for a malformed (non-base64) public key", () => {
  assert.equal(
    resolveVapidConfig(
      envFrom({
        VAPID_PUBLIC_KEY: "not a real key!!!",
        VAPID_PRIVATE_KEY: FAKE_PRIVATE_KEY,
        VAPID_SUBJECT: FAKE_SUBJECT,
      }),
    ),
    null,
  );
});

Deno.test("R: resolveVapidConfig returns null for a public key of the wrong decoded length", () => {
  assert.equal(
    resolveVapidConfig(
      envFrom({
        VAPID_PUBLIC_KEY: "QUJD",
        VAPID_PRIVATE_KEY: FAKE_PRIVATE_KEY,
        VAPID_SUBJECT: FAKE_SUBJECT,
      }),
    ),
    null,
  );
});

Deno.test("R: resolveVapidConfig returns null for an obviously too-short private key", () => {
  assert.equal(
    resolveVapidConfig(
      envFrom({
        VAPID_PUBLIC_KEY: FAKE_VALID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY: "short",
        VAPID_SUBJECT: FAKE_SUBJECT,
      }),
    ),
    null,
  );
});

Deno.test("R: resolveVapidConfig returns null for a subject that is neither mailto: nor https:", () => {
  assert.equal(
    resolveVapidConfig(
      envFrom({
        VAPID_PUBLIC_KEY: FAKE_VALID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY: FAKE_PRIVATE_KEY,
        VAPID_SUBJECT: "not-a-valid-subject",
      }),
    ),
    null,
  );
});

Deno.test("R: resolveVapidConfig returns null for blank (whitespace-only) values", () => {
  assert.equal(
    resolveVapidConfig(
      envFrom({
        VAPID_PUBLIC_KEY: "   ",
        VAPID_PRIVATE_KEY: FAKE_PRIVATE_KEY,
        VAPID_SUBJECT: FAKE_SUBJECT,
      }),
    ),
    null,
  );
});
