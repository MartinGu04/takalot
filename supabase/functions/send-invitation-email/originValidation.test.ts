// Uses node:assert (via Deno's node: compat layer), not jsr:@std/assert or
// deno.land/std -- both need a network fetch this environment blocks; see
// send-push-notification/webhookAuth.test.ts for the same convention.
import assert from "node:assert/strict";
import { sanitizeAppOrigin } from "./originValidation.ts";

Deno.test("sanitizeAppOrigin: accepts a plain https origin", () => {
  assert.equal(sanitizeAppOrigin("https://avaria.example.com"), "https://avaria.example.com");
});

Deno.test("sanitizeAppOrigin: accepts a plain http origin (local dev)", () => {
  assert.equal(sanitizeAppOrigin("http://localhost:5173"), "http://localhost:5173");
});

Deno.test("sanitizeAppOrigin: strips a path/query/hash down to the bare origin", () => {
  assert.equal(
    sanitizeAppOrigin("https://avaria.example.com/login?next=/incidents#foo"),
    "https://avaria.example.com",
  );
});

Deno.test("sanitizeAppOrigin: strips embedded credentials", () => {
  assert.equal(sanitizeAppOrigin("https://user:pass@avaria.example.com"), "https://avaria.example.com");
});

Deno.test("sanitizeAppOrigin: rejects a javascript: URL", () => {
  assert.equal(sanitizeAppOrigin("javascript:alert(1)"), null);
});

Deno.test("sanitizeAppOrigin: rejects a non-URL string", () => {
  assert.equal(sanitizeAppOrigin("not a url"), null);
});

Deno.test("sanitizeAppOrigin: rejects null/undefined/non-string input", () => {
  assert.equal(sanitizeAppOrigin(null), null);
  assert.equal(sanitizeAppOrigin(undefined), null);
  assert.equal(sanitizeAppOrigin(42), null);
  assert.equal(sanitizeAppOrigin({}), null);
});

Deno.test("sanitizeAppOrigin: rejects an empty or whitespace-only string", () => {
  assert.equal(sanitizeAppOrigin(""), null);
  assert.equal(sanitizeAppOrigin("   "), null);
});

Deno.test("sanitizeAppOrigin: rejects an absurdly long string", () => {
  assert.equal(sanitizeAppOrigin("https://" + "a".repeat(300) + ".com"), null);
});

Deno.test("sanitizeAppOrigin: rejects a non-http(s) scheme", () => {
  assert.equal(sanitizeAppOrigin("ftp://files.example.com"), null);
  assert.equal(sanitizeAppOrigin("data:text/html,hi"), null);
});
