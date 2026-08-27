import assert from "node:assert/strict";
import { buildInvitationEmail } from "./invitationEmail.ts";
import type { InvitationRecipient } from "./types.ts";

const RECIPIENT: InvitationRecipient = {
  fullName: "ישראל ישראלי",
  email: "israel@example.com",
  role: "technician",
};

Deno.test("buildInvitationEmail: subject is set and role-independent", () => {
  const content = buildInvitationEmail(RECIPIENT, "https://avaria.example.com");
  assert.equal(content.subject, "הזמנה למערכת AVARIA");
});

Deno.test("buildInvitationEmail: html includes the recipient's name, email and role label", () => {
  const content = buildInvitationEmail(RECIPIENT, "https://avaria.example.com");
  assert.ok(content.html.includes("ישראל ישראלי"));
  assert.ok(content.html.includes("israel@example.com"));
  assert.ok(content.html.includes("טכנאי"));
});

Deno.test("buildInvitationEmail: html is RTL", () => {
  const content = buildInvitationEmail(RECIPIENT, "https://avaria.example.com");
  assert.ok(content.html.includes('dir="rtl"'));
});

Deno.test("buildInvitationEmail: links to <appUrl>/login and embeds the logo from <appUrl>", () => {
  const content = buildInvitationEmail(RECIPIENT, "https://avaria.example.com");
  assert.ok(content.html.includes("https://avaria.example.com/login"));
  assert.ok(content.text.includes("https://avaria.example.com/login"));
  assert.ok(content.html.includes("https://avaria.example.com/branding/avaria-compact-micro-mark.png"));
});

Deno.test("buildInvitationEmail: the CTA renders as כניסה ל־AVARIA (Hebrew maqaf, not an ASCII hyphen) with explicit RTL isolation", () => {
  const content = buildInvitationEmail(RECIPIENT, "https://avaria.example.com");
  // The literal button text, in the intended logical (and only correct)
  // order: Hebrew phrase, maqaf, then the Latin brand name -- not the
  // ASCII-hyphen form that a bidi-unaware client can reorder to
  // "AVARIA-כניסה ל".
  assert.ok(content.html.includes("כניסה ל־AVARIA"));
  assert.ok(!content.html.includes("כניסה ל-AVARIA"));
  assert.ok(content.text.includes("כניסה ל־AVARIA:"));
  // The <a> itself carries an explicit RTL attribute/style, independent
  // of the ambient <html dir="rtl"> -- a client that resolves this
  // element's own direction separately (as Gmail's sanitizer can) still
  // renders it correctly.
  const ctaMatch = content.html.match(/<a href="[^"]*\/login"[^>]*>/);
  assert.ok(ctaMatch, "expected to find the CTA <a> tag");
  assert.ok(ctaMatch![0].includes('dir="rtl"'));
  assert.ok(ctaMatch![0].includes("direction:rtl"));
});

Deno.test("buildInvitationEmail: the CTA link is always built from appUrl, never any other source", () => {
  const content = buildInvitationEmail(RECIPIENT, "https://trusted-server-configured.example");
  // Only one href appears anywhere in the email, and it is exactly appUrl/login.
  const hrefs = [...content.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["https://trusted-server-configured.example/login"]);
});

Deno.test("buildInvitationEmail: escapes HTML-significant characters in the name", () => {
  const content = buildInvitationEmail(
    { ...RECIPIENT, fullName: '<script>alert("x")</script>' },
    "https://avaria.example.com",
  );
  assert.ok(!content.html.includes("<script>"));
  assert.ok(content.html.includes("&lt;script&gt;"));
});

Deno.test("buildInvitationEmail: falls back to the email address when fullName is blank", () => {
  const content = buildInvitationEmail({ ...RECIPIENT, fullName: "   " }, "https://avaria.example.com");
  assert.ok(content.html.includes("israel@example.com"));
});

Deno.test("buildInvitationEmail: renders every role label distinctly", () => {
  const roles: InvitationRecipient["role"][] = [
    "system_admin",
    "professional_manager",
    "shift_supervisor",
    "technician",
    "viewer",
  ];
  const labels = roles.map((role) => buildInvitationEmail({ ...RECIPIENT, role }, "https://avaria.example.com").text);
  assert.equal(new Set(labels).size, roles.length);
});
