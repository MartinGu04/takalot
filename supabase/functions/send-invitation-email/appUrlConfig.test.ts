// Uses node:assert (via Deno's node: compat layer), not jsr:@std/assert or
// deno.land/std -- both need a network fetch this environment blocks; see
// send-push-notification/webhookAuth.test.ts for the same convention.
import assert from "node:assert/strict";
import { resolveAppUrl } from "./appUrlConfig.ts";

function envOf(vars: Record<string, string>) {
  return (name: string) => vars[name];
}

Deno.test("resolveAppUrl: accepts a well-formed https URL", () => {
  assert.equal(resolveAppUrl(envOf({ AVARIA_APP_URL: "https://avaria.example.com" })), "https://avaria.example.com");
});

Deno.test("resolveAppUrl: strips a path/query/hash down to the bare origin", () => {
  assert.equal(
    resolveAppUrl(envOf({ AVARIA_APP_URL: "https://avaria.example.com/login?next=/incidents#foo" })),
    "https://avaria.example.com",
  );
});

Deno.test("resolveAppUrl: strips embedded credentials", () => {
  assert.equal(
    resolveAppUrl(envOf({ AVARIA_APP_URL: "https://user:pass@avaria.example.com" })),
    "https://avaria.example.com",
  );
});

Deno.test("resolveAppUrl: preserves a non-default port", () => {
  assert.equal(resolveAppUrl(envOf({ AVARIA_APP_URL: "https://avaria.example.com:8443" })), "https://avaria.example.com:8443");
});

Deno.test("resolveAppUrl: rejects a plain http URL -- https is required, not just well-formed", () => {
  assert.equal(resolveAppUrl(envOf({ AVARIA_APP_URL: "http://avaria.example.com" })), null);
});

Deno.test("resolveAppUrl: rejects a non-http(s) scheme", () => {
  assert.equal(resolveAppUrl(envOf({ AVARIA_APP_URL: "javascript:alert(1)" })), null);
  assert.equal(resolveAppUrl(envOf({ AVARIA_APP_URL: "ftp://files.example.com" })), null);
  assert.equal(resolveAppUrl(envOf({ AVARIA_APP_URL: "data:text/html,hi" })), null);
});

Deno.test("resolveAppUrl: rejects a non-URL string", () => {
  assert.equal(resolveAppUrl(envOf({ AVARIA_APP_URL: "not a url" })), null);
});

Deno.test("resolveAppUrl: rejects when the variable is unset, empty, or whitespace-only", () => {
  assert.equal(resolveAppUrl(envOf({})), null);
  assert.equal(resolveAppUrl(envOf({ AVARIA_APP_URL: "" })), null);
  assert.equal(resolveAppUrl(envOf({ AVARIA_APP_URL: "   " })), null);
});

Deno.test("resolveAppUrl: rejects an absurdly long value", () => {
  assert.equal(resolveAppUrl(envOf({ AVARIA_APP_URL: "https://" + "a".repeat(300) + ".com" })), null);
});

Deno.test("resolveAppUrl: never reads any variable other than AVARIA_APP_URL", () => {
  assert.equal(
    resolveAppUrl(envOf({ origin: "https://attacker.example.com", ORIGIN: "https://attacker.example.com" })),
    null,
  );
});
