// Pure builder: (recipient, appUrl) -> { subject, html, text }. No I/O, no
// Deno/env access -- exactly the dispatch.ts-style split this codebase
// already uses (see send-push-notification/dispatch.ts), so the entire
// template can be unit tested without a real email provider or database.
//
// `appUrl` must be the server-trusted origin resolved by
// appUrlConfig.resolveAppUrl -- NEVER anything client-supplied. This
// module has no fallback/degraded path for a missing or untrusted URL by
// design: the caller (index.ts) only invokes buildInvitationEmail once
// AVARIA_APP_URL has already been confirmed configured and valid: when it
// isn't, index.ts records the send as failed and never calls this
// function at all, rather than emailing a link built from anything else.
//
// RTL by construction (dir="rtl" on every text-bearing element, Hebrew
// copy throughout) and mobile-friendly (a single-column, max-width table
// layout with inline styles only -- the only markup email clients reliably
// render consistently; no external stylesheet, no flex/grid).
import type { InvitationEmailContent, InvitationRecipient } from "./types.ts";

const ROLE_LABELS: Record<InvitationRecipient["role"], string> = {
  system_admin: "מנהל מערכת",
  professional_manager: "מנהל מקצועי",
  shift_supervisor: 'אחמ"ש',
  technician: "טכנאי",
  viewer: "צופה",
};

const BRAND_PURPLE = "#6d28d9";
const BRAND_PURPLE_DARK = "#4c1d95";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildInvitationEmail(
  recipient: InvitationRecipient,
  appUrl: string,
): InvitationEmailContent {
  const roleLabel = ROLE_LABELS[recipient.role];
  const displayName = recipient.fullName.trim() || recipient.email;
  const safeName = escapeHtml(displayName);
  const safeEmail = escapeHtml(recipient.email);
  const safeRole = escapeHtml(roleLabel);
  const loginUrl = `${appUrl}/login`;
  const logoUrl = `${appUrl}/branding/avaria-compact-micro-mark.png`;

  const subject = "הזמנה למערכת AVARIA";

  // A plain ASCII hyphen between a Hebrew word and a Latin brand name is a
  // WEAK/neutral bidi character (Bidi_Class ES/CS) -- inside an <a> whose
  // own effective direction some clients (Gmail's sanitizer included)
  // resolve as LTR rather than inheriting the surrounding RTL context, the
  // Unicode Bidi Algorithm can then lay the two runs out in LOGICAL
  // left-to-right order ("AVARIA" first, then the Hebrew phrase) instead
  // of the intended RTL order -- each run still reads correctly on its
  // own, only their relative order flips. Two independent, redundant
  // fixes, since no single one is guaranteed to survive every client's
  // HTML sanitizer: (1) `dir="rtl"` set directly as an HTML ATTRIBUTE on
  // the <a> itself (attributes tend to survive sanitizers that strip
  // inline CSS), backed by `direction:rtl;unicode-bidi:isolate` in its
  // own inline style; (2) the Hebrew maqaf (־, U+05BE) instead of an
  // ASCII hyphen as the separator -- a STRONG right-to-left character
  // (Bidi_Class R), so it can never be grouped with the adjacent Latin
  // run the way a neutral hyphen can.
  const ctaHtml = `<a href="${escapeHtml(loginUrl)}" dir="rtl"
           style="display:inline-block;background-color:${BRAND_PURPLE};color:#ffffff;
                  font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;
                  text-decoration:none;padding:14px 40px;border-radius:10px;
                  direction:rtl;unicode-bidi:isolate;">
          כניסה ל־AVARIA
        </a>`;

  const logoHtml = `<img src="${escapeHtml(logoUrl)}" width="56" height="56" alt="AVARIA"
            style="display:block;border-radius:14px;" />`;

  const html = `<!doctype html>
<html dir="rtl" lang="he">
  <body style="margin:0;padding:0;background-color:#f4f2fb;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f2fb;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                 style="max-width:480px;background-color:#ffffff;border-radius:16px;overflow:hidden;
                        box-shadow:0 1px 3px rgba(0,0,0,0.08);">
            <tr>
              <td style="background-color:${BRAND_PURPLE_DARK};padding:28px 24px;text-align:center;">
                ${logoHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:32px 28px 8px 28px;font-family:Arial,Helvetica,sans-serif;text-align:right;direction:rtl;">
                <p style="margin:0 0 4px 0;font-size:20px;font-weight:bold;color:#1f1235;">שלום ${safeName},</p>
                <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#3f3f46;">
                  ניתנה לך גישה למערכת <strong>AVARIA</strong>, בתפקיד
                  <strong style="color:${BRAND_PURPLE};">${safeRole}</strong>.
                </p>
                <p style="margin:0;font-size:14px;line-height:1.6;color:#52525b;">
                  ההתחברות היא באמצעות חשבון ה-Google הבא:<br />
                  <span dir="ltr" style="display:inline-block;margin-top:4px;font-family:monospace,Arial;color:#1f1235;">${safeEmail}</span>
                </p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:28px 28px 8px 28px;">${ctaHtml}</td>
            </tr>
            <tr>
              <td style="padding:8px 28px 28px 28px;font-family:Arial,Helvetica,sans-serif;text-align:center;">
                <p style="margin:0;font-size:12px;color:#a1a1aa;">
                  אין צורך באישור נוסף — ההרשאה כבר פעילה במערכת.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    `שלום ${displayName},`,
    "",
    `ניתנה לך גישה למערכת AVARIA, בתפקיד ${roleLabel}.`,
    `ההתחברות היא באמצעות חשבון ה-Google: ${recipient.email}`,
    "",
    `כניסה ל־AVARIA: ${loginUrl}`,
    "",
    "אין צורך באישור נוסף — ההרשאה כבר פעילה במערכת.",
  ].join("\n");

  return { subject, html, text };
}
