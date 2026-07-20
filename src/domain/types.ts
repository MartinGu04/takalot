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
  | 'reopened';

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
  | 'reopened';

export interface Profile {
  id: string;
  fullName: string;
  role: Role;
  active: boolean;
  createdAt: string; // ISO UTC
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
  /** 'pending' for pending entries; 'active' | 'inactive' for linked profiles. */
  state: 'pending' | 'active' | 'inactive';
  createdAt: string;
}

export interface SystemRecord {
  id: string;
  name: string;
  archived: boolean;
  createdAt: string;
}

export interface LocationRecord {
  id: string;
  name: string;
  archived: boolean;
  createdAt: string;
}

/** Owner is either an active internal user or a named external handler. */
export interface Owner {
  userId: string | null;
  externalName: string | null;
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
  ownerExternalName: string | null;
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
];

export function isOpen(status: IncidentStatus): boolean {
  return status !== 'closed';
}
