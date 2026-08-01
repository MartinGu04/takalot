// Core domain types. All enum-like values are fixed in the MVP (not user-editable).

export type Role =
  | 'system_admin'
  | 'professional_manager'
  | 'shift_supervisor'
  | 'technician'
  | 'viewer';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type IncidentStatus =
  | 'new'
  | 'acknowledged'
  | 'in_progress'
  | 'waiting_external'
  | 'waiting_test'
  | 'monitoring'
  | 'partial_readiness'
  | 'resolved_pending_close'
  | 'closed'
  | 'reopened'
  | 'cancelled'
  | 'waiting_equipment'
  | 'waiting_information'
  | 'waiting_validation';

export type Readiness = 'full' | 'partial' | 'none';

export type ReportedToOps = 'yes' | 'no' | 'not_required';

export type EventType =
  | 'created'
  | 'acknowledged'
  | 'update'
  | 'status_change'
  | 'severity_change'
  | 'impact_change'
  | 'assignment_change'
  | 'deadline_change'
  | 'reported_to_ops_change'
  | 'correction'
  | 'handover_included'
  | 'handover_accepted'
  | 'closed'
  | 'follow_up_completed'
  | 'reopened'
  | 'cancelled'
  | 'severity_assessed'
  | 'status_check_changed'
  | 'reported_to_ops_room'
  | 'reported_to_ops_communications';

export interface Profile {
  id: string;
  fullName: string;
  role: Role;
  active: boolean;
  createdAt: string; // ISO UTC
  /** Set once the profile has been permanently deleted (tombstoned) via
   *  the server-side delete-user flow. Optional: absent/undefined for any
   *  profile that has never been deleted, and for data shaped before this
   *  field existed. */
  deletedAt?: string | null;
  deletedBy?: string | null;
  /** Persisted Google avatar image URL, set best-effort on sign-in via
   *  set_own_avatar_url(). Optional: absent/undefined for data shaped
   *  before this field existed, and always null/absent in demo mode
   *  (no OAuth session to read a picture from). */
  avatarUrl?: string | null;
}

export type PendingPersonnelStatus = 'pending' | 'claimed' | 'cancelled' | 'expired';

/** A pre-provisioned personnel entry: created by an authorized role BEFORE
 *  the person's first Google sign-in, and claimed automatically (server-
 *  side, against the verified email) on their first authenticated session. */
export interface PendingPersonnel {
  id: string;
  fullName: string;
  /** Always normalized: trim + lowercase. */
  email: string;
  role: Role;
  status: PendingPersonnelStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
}

/** One row of the unified, management-safe personnel listing: a live
 *  pending entry or an already-linked profile. The backend (list_personnel)
 *  exposes exactly these fields -- never raw auth.users data. `id` targets
 *  management RPCs; it is not for display and is never typed by a user. */
export interface PersonnelEntry {
  kind: 'pending' | 'linked';
  id: string;
  fullName: string;
  /** Normalized Google email; null for a linked profile with no auth identity. */
  email: string | null;
  role: Role;
  /** 'pending' for pending entries; 'active' | 'inactive' | 'deleted' for
   *  linked profiles. 'deleted' means permanently tombstoned via the
   *  server-side delete-user flow -- the name/role shown are permanent
   *  historical record, not a live, manageable account. */
  state: 'pending' | 'active' | 'inactive' | 'deleted';
  createdAt: string;
  /** Stored Google avatar image URL for a linked profile; always null for
   *  a pending entry (it has no auth identity yet). */
  avatarUrl: string | null;
}

export interface SystemRecord {
  id: string;
  name: string;
  archived: boolean;
  displayOrder: number;
  createdAt: string;
}

export interface LocationRecord {
  id: string;
  name: string;
  archived: boolean;
  displayOrder: number;
  createdAt: string;
}

export interface Incident {
  id: string;
  number: string; // YYYY-NNN, database-generated, immutable
  version: number; // optimistic concurrency
  systemId: string;
  locationId: string;
  description: string;
  severity: Severity;
  status: IncidentStatus;
  operationalImpact: string;
  ownerUserId: string | null;
  /** Legacy, frozen historical column: "external instead of an internal
   *  owner" for incidents opened before the additive external handling
   *  party model. No RPC writes or clears it anymore -- read-only. Never
   *  rendered as a substitute for the internal owner; a legacy row with
   *  this set and ownerUserId null shows as "ללא בעל אחריות פנימי" in
   *  compact contexts, same as any other row with no internal owner. */
  ownerExternalName: string | null;
  /** Additive external handling party -- always optional, never a
   *  substitute for ownerUserId. Independent of the internal owner: an
   *  incident can have both, neither, or just one. */
  externalHandlerName: string | null;
  /** Required and meaningful only alongside externalHandlerName. */
  externalHandlerContactPerson: string | null;
  externalHandlerContactDetails: string | null;
  discoveredAt: string; // user-entered discovery time
  createdAt: string; // authoritative server time
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  lastUpdateAt: string; // time of last content update / lifecycle action
  nextUpdateDue: string | null; // null only with explicit reason
  noDeadlineReason: string | null;
  reportedToOps: ReportedToOps;
  /** Concise free-text recipient (role and/or name); required and shown only when reportedToOps is 'yes'. */
  reportedToOpsRecipient: string | null;
  // Opening-time reporting questions (set only via create_incident; no update
  // path exists for these in this PR -- they describe what was true at the
  // moment the incident was opened, not an ongoing status).
  /** "האם דווח לתקשוב למבצעים?" */
  reportedToComms: boolean;
  /** "למי דווח?" -- required and shown only when reportedToComms is true. */
  reportedToCommsRecipient: string | null;
  /** "האם נפתחה תקלה ב-WISDOM?" */
  wisdomReported: boolean;
  /** "מספר תקלה ב-WISDOM" -- required and shown only when wisdomReported is true. */
  wisdomIncidentNumber: string | null;
  // Closure fields (set only via closure flow)
  closedAt: string | null;
  closedBy: string | null;
  rootCause: string | null;
  resolution: string | null;
  readinessAtClose: Readiness | null;
  followUpNotes: string | null;
  followUpRequired: boolean;
  followUpCompletedAt: string | null;
  followUpCompletedBy: string | null;
  reopenCount: number;
  // Cancellation fields (set only via the cancellation flow)
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
}

export interface IncidentUpdate {
  id: string;
  incidentId: string;
  authorId: string;
  eventTime: string; // user-entered actual time
  serverTime: string; // authoritative submission time
  actionsTaken: string;
  findings: string;
  nextSteps: string;
  // The situational "סטטוס נוכחי" free text at the moment of this update.
  // Nullable forever: historical rows predating this field, and any update
  // where the RPC's stage-1 accept-and-persist contract saw it omitted,
  // never had one.
  currentStatusText: string | null;
  // Update-specific reporting: three fresh questions asked at THIS update
  // only ("דווח למבצעים?" / "האם דווח לתקשוב למבצעים?" / "האם עודכן
  // ב-WISDOM?"), never inherited from and never written back onto the
  // incident's own opening-time reporting facts (Incident.reportedToOps/
  // .reportedToComms/.wisdomReported). Nullable forever: historical rows
  // predating this feature, and any update where the RPC's compatibility
  // window saw the corresponding payload key omitted, never had an answer
  // -- NULL means "not answered for this update," not "no."
  updateReportedToOps: ReportedToOps | null;
  /** Required and shown only when updateReportedToOps is 'yes'. */
  updateReportedToOpsRecipient: string | null;
  updateReportedToComms: boolean | null;
  /** Required and shown only when updateReportedToComms is true. */
  updateReportedToCommsRecipient: string | null;
  updateWisdomReported: boolean | null;
  createdAt: string;
}

export interface IncidentEvent {
  id: string;
  incidentId: string;
  type: EventType;
  actorId: string | null;
  actorLabel: string | null; // external actor display when relevant
  eventTime: string; // when the event actually happened (user-entered where allowed)
  serverTime: string; // authoritative server record time
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  note: string | null;
  refId: string | null; // e.g. corrected update/event id, handover id
  createdAt: string;
  /** Groups every row one user operation produced (e.g. all the field
   *  changes from one "עדכון תקלה" submission) under one shared id. Null on
   *  every row written before this field existed, and permanently so --
   *  incident_events is append-only, so a historical row can never be
   *  backfilled. Null is a normal, expected value, not missing data. */
  operationId: string | null;
}

export type HandoverStatus = 'pending' | 'accepted';

export interface Handover {
  id: string;
  createdBy: string;
  createdAt: string;
  toUserId: string;
  generalNote: string;
  status: HandoverStatus;
  acceptedAt: string | null;
  acceptedBy: string | null;
}

export interface HandoverItem {
  id: string;
  handoverId: string;
  incidentId: string;
  note: string;
  // Snapshot fields frozen at handover creation
  snapshotNumber: string;
  snapshotStatus: IncidentStatus;
  snapshotSeverity: Severity;
  snapshotOwnerLabel: string;
  snapshotSystemName: string;
  snapshotLocationName: string;
  snapshotImpact: string;
  snapshotLastAction: string;
  snapshotNextSteps: string;
  snapshotNextUpdateDue: string | null;
}

export interface HandoverAddendum {
  id: string;
  handoverId: string;
  authorId: string;
  text: string;
  createdAt: string;
}

export type NotificationType =
  | 'incident_assigned'
  // 'update_overdue': the next-update-ETA concept is no longer an active
  // product feature (no new row of this type is ever written), but hosted
  // databases may still contain historical rows of it. Kept in the domain
  // type and label mapping for read compatibility; both repositories filter
  // it out of active listNotifications results (see PR review follow-up).
  | 'update_overdue'
  | 'incident_reopened'
  | 'handover_pending';

export interface AppNotification {
  id: string;
  userId: string;
  type: NotificationType;
  incidentId: string | null;
  handoverId: string | null;
  text: string;
  read: boolean;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  incidentNumber: string | null;
  before: string | null; // JSON string
  after: string | null; // JSON string
  correlationId: string | null;
  createdAt: string;
}

/** Fixed order used for priority sorting. */
export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

export const OPEN_STATUSES: IncidentStatus[] = [
  'new',
  'acknowledged',
  'in_progress',
  'waiting_external',
  'waiting_test',
  'monitoring',
  'partial_readiness',
  'resolved_pending_close',
  'reopened',
  'waiting_equipment',
  'waiting_information',
  'waiting_validation',
];

export function isOpen(status: IncidentStatus): boolean {
  return status !== 'closed' && status !== 'cancelled';
}
