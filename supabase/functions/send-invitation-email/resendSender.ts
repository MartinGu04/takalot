// Outbound email delivery via Resend's plain HTTP API
// (https://api.resend.com/emails) -- a single fetch() call, no SDK
// dependency, matching this function's other modules' preference for
// dependency-free implementations over an extra npm import (see
// originValidation.ts/invitationEmail.ts). RESEND_API_KEY is read once by
// index.ts (module scope, same pattern as VAPID_* in
// send-push-notification/vapidConfig.ts) and passed in here -- this module
// never reads Deno.env itself, which is what keeps it unit-testable with a
// fake fetch and no real network access.
import type { SendEmailFn, SendEmailResult } from "./types.ts";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface ResendConfig {
  apiKey: string;
  /** A verified Resend sender, e.g. "AVARIA <invitations@your-domain>". */
  fromAddress: string;
}

/**
 * Builds a SendEmailFn backed by Resend. `fetchImpl` defaults to the
 * global fetch but is overridable for tests -- never performs a real
 * network call in a test environment.
 */
export function createResendSender(
  config: ResendConfig,
  fetchImpl: typeof fetch = fetch,
): SendEmailFn {
  return async ({ to, subject, html, text }): Promise<SendEmailResult> => {
    let response: Response;
    try {
      response = await fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: config.fromAddress,
          to: [to],
          subject,
          html,
          text,
        }),
      });
    } catch (networkError) {
      console.error(
        "send-invitation-email: Resend request failed (network):",
        networkError,
      );
      return { outcome: "failed", message: "שגיאת רשת בשליחת ההזמנה." };
    }

    if (response.ok) {
      return { outcome: "sent" };
    }

    // The provider's raw response body (which can carry account/API detail)
    // is logged server-side only -- never forwarded to the client or stored
    // verbatim in the database. record_pending_personnel_invitation_result
    // stores only this fixed, safe Hebrew message.
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      // Best-effort -- the status code alone is still enough to log.
    }
    console.error(
      `send-invitation-email: Resend request failed with status ${response.status}:`,
      bodyText,
    );
    if (response.status === 401 || response.status === 403) {
      return {
        outcome: "failed",
        message: "תצורת שליחת הדוא\"ל בצד השרת שגויה.",
      };
    }
    return { outcome: "failed", message: "שליחת ההזמנה נכשלה בצד ספק הדוא\"ל." };
  };
}
