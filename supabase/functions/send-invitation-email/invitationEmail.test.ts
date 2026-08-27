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

Deno.test("buildInvitationEmail: with an origin, links to <origin>/login", () => {
  const content = buildInvitationEmail(RECIPIENT, "https://avaria.example.com");
  assert.ok(content.html.includes("https://avaria.example.com/login"));
  assert.ok(content.text.includes("https://avaria.example.com/login"));
});

Deno.test("buildInvitationEmail: with no origin, falls back to plain instructions and no broken link", () => {
  const content = buildInvitationEmail(RECIPIENT, null);
  assert.ok(!content.html.includes("href="));
  assert.ok(content.html.includes("AVARIA"));
  assert.ok(content.text.includes("AVARIA"));
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
  const labels = roles.map((role) => buildInvitationEmail({ ...RECIPIENT, role }, null).text);
  assert.equal(new Set(labels).size, roles.length);
});
