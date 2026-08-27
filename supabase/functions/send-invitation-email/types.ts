// Shared types for the send-invitation-email Edge Function. Kept in one
// file, exactly like send-push-notification/types.ts, so index.ts,
// invitationEmail.ts and resendSender.ts all agree on the same shapes
// without importing from each other's implementation files.

export type InvitationRole =
  | "system_admin"
  | "professional_manager"
  | "shift_supervisor"
  | "technician"
  | "viewer";

export interface InvitationRecipient {
  fullName: string;
  email: string;
  role: InvitationRole;
}

export interface InvitationEmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface SendEmailResult {
  outcome: "sent" | "failed";
  /** Safe, human-readable (Hebrew) explanation -- present only when
   *  outcome is 'failed'. Never the provider's raw response body. */
  message?: string;
}

export type SendEmailFn = (email: {
  to: string;
  subject: string;
  html: string;
  text: string;
}) => Promise<SendEmailResult>;
