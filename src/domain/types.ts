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

/** Where the problem is currently observed/manifested -- set once at
 *  incident creation, never a confirmed root cause. `null` means the
 *  incident was never classified (a legacy incident, or one created
 *  through the still-permissive legacy create_incident RPC) -- distinct
 *  from the explicit `'unknown'` member, which means a user actively
 *  looked and concluded "not yet known at this stage." The two are never
 *  conflated: a `null` incident renders "לא סווג בעת פתיחת התקלה". */
export type IncidentDomain =
  | 'communications'
  | 'equipment'
  | 'software'
  | 'infrastructure'
  | 'operational'
  | 'unknown'
  | 'other';

/** The CURRENT suspected cause -- mutable over the incident's life, every
 *  change preserved via IncidentCauseAssessment history. `null` on
 *  Incident.currentSuspectedCause means "never assessed" (renders "לא
 *  הוזנה הערכת גורם"); the explicit `'unknown'` member means "assessed,
 *  and the conclusion was not yet known" (renders "הגורם טרם ידוע") --
 *  a deliberately different state from `null`, never conflated. */
export type SuspectedCause =
  | 'equipment'
  | 'software'
  | 'communications'
  | 'infrastructure'
  | 'operational'
  | 'external'
  | 'unknown'
  | 'other';

/** Structured, cumulative treatment actions -- supplement, never replace,
 *  the existing free-text actionsTaken/currentStatusText fields. */
export type TreatmentActionType =
  | 'diagnosis'
  | 'reset_restart'
  | 'equipment_replacement'
  | 'config_change'
  | 'software_fix'
  | 'communications_handling'
  | 'infrastructure_handling'
  | 'external_party_handling'
  | 'other';

/** The cause CONFIRMED at closure -- a separate concept from the mutable,
 *  pre-closure SuspectedCause, recorded per-closure-cycle. */
export type ConfirmedCause =
  | 'equipment'
  | 'software'
  | 'communications'
  | 'infrastructure'
  | 'operational'
  | 'external'
  | 'undetermined'
  | 'other';

export type TreatmentOutcome =
  | 'permanent_resolution'
  | 'temporary_workaround'
  | 'not_reproduced'
  | 'resolved_without_action'
  | 'closed_without_technical_resolution'
  | 'other';

/** What is known about what resolved the incident -- deliberately not
 *  "the action that resolved it": that framing is not always knowable. */
export type ResolutionAttribution =
  | 'specific_action'
  | 'combination_of_actions'
  | 'undetermined'
  | 'no_action_taken'
  | 'external_party_no_details'
  | 'other';

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
  // 'handover_included'/'handover_accepted': written by the now-removed
  // shift-handover feature. Kept for read compatibility with historical
  // incident timeline rows, exactly like 'handover_pending' below.
  | 'handover_included'
  | 'handover_accepted'
  | 'closed'
  | 'follow_up_completed'
  | 'reopened'
  | 'cancelled'
  | 'severity_assessed'
  | 'status_check_changed'
  | 'reported_to_ops_room'
  | 'reported_to_ops_communications'
  // Written only when a genuine current-suspected-cause CHANGE is made
  // through an update (has a real effective event_time). The initial
  // cause entered at creation has no known effective time and is never
  // represented by this event type -- it renders inline on the creation
  // timeline card instead (see Timeline.tsx).
  | 'cause_assessment_changed';

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
  /** Personal, self-managed opt-in to role-based operational notifications
   *  (see NotificationCategory) -- meaningful only for `system_admin`
   *  (`professional_manager` always receives them regardless of this
   *  field, and every other role never does, even if this were somehow
   *  true). Optional like `avatarUrl`: absent/undefined is equivalent to
   *  false everywhere it is read, so fixtures and data shaped before this
   *  field existed never need an explicit value. Changed only via
   *  setMyOperationalNotificationsEnabled, never directly. */
  operationalNotificationsEnabled?: boolean;
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

/** Fixed, product-defined categories -- not administratively configurable.
 *  Declaration order here is also the required fixed UI display order
 *  (mirrors the system_category/location_category enum declaration order
 *  in migration 0041, which sorts the same way in the database). */
export type SystemCategory = 'platforms' | 'station_systems' | 'computing' | 'infrastructure' | 'other';

export type LocationCategory =
  | 'unit_internal'
  | 'field_side'
  | 'external_bases'
  | 'external_sites'
  | 'other';

export interface SystemRecord {
  id: string;
  name: string;
  archived: boolean;
  category: SystemCategory;
  /** Position within this record's OWN category, not the whole table --
   *  two records in different categories may share the same displayOrder. */
  displayOrder: number;
  createdAt: string;
}

export interface LocationRecord {
  id: string;
  name: string;
  archived: boolean;
  category: LocationCategory;
  /** Position within this record's OWN category, not the whole table --
   *  two records in different categories may share the same displayOrder. */
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
  /** תחום התקלה -- where the problem is currently observed, set once at
   *  creation. `null` means never classified (legacy incident, or one
   *  created through the still-permissive legacy create_incident RPC),
   *  never conflated with the explicit 'unknown' enum member. */
  reportedDomain: IncidentDomain | null;
  /** The current suspected cause -- denormalized mirror of the latest
   *  IncidentCauseAssessment. `null` means never assessed; the explicit
   *  'unknown' value means assessed and concluded not-yet-known. Reset to
   *  `null` on reopen -- never carries the previous cycle's assessment,
   *  or the just-superseded confirmed cause, forward as a freshly
   *  reconfirmed fact. */
  currentSuspectedCause: SuspectedCause | null;
  /** Required and meaningful only when currentSuspectedCause is 'other'. */
  currentSuspectedCauseOtherDetail: string | null;
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
  /** Optional free-text "הערה נוספת" entered with this specific update.
   *  Distinct from actionsTaken/findings/nextSteps/currentStatusText --
   *  never generated, never required. Null when omitted or blank. */
  userNote: string | null;
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
  /** Optional free-text "הערה נוספת" entered by the actor with this
   *  specific event (create_incident's 'created' row, close_incident's
   *  'closed'/partial-readiness 'status_change' row). Always a SEPARATE
   *  field from `note` above -- `note` already carries generated narrative
   *  text (or, on update_incident's status/severity-change rows, the
   *  distinct `changeReason`) and is never overwritten by this. Null when
   *  omitted or blank, and always null on event types that don't carry it. */
  userNote: string | null;
  refId: string | null; // e.g. corrected update/event id, handover id
  createdAt: string;
  /** Groups every row one user operation produced (e.g. all the field
   *  changes from one "עדכון תקלה" submission) under one shared id. Null on
   *  every row written before this field existed, and permanently so --
   *  incident_events is append-only, so a historical row can never be
   *  backfilled. Null is a normal, expected value, not missing data. */
  operationId: string | null;
}

/** One historical row of the incident's current-suspected-cause value.
 *  Append-only -- every change is preserved, never overwritten. */
export interface IncidentCauseAssessment {
  id: string;
  incidentId: string;
  cause: SuspectedCause;
  /** Required and meaningful only when cause is 'other'. */
  otherDetail: string | null;
  /** incidents.reopenCount at write time -- 0 for the original incident,
   *  1 after the first reopen, etc. Partitions history by open/closed
   *  cycle. */
  cycleNumber: number;
  recordedBy: string;
  /** The real effective time this assessment became true, when known.
   *  `null` for the initial assessment recorded at incident creation --
   *  no time is ever collected for it, and this field is never
   *  fabricated to imply one (see recordedAt below, and Timeline.tsx's
   *  "תועד בעת פתיחת התקלה" rendering for these rows). Every assessment
   *  recorded through an update carries a real effective eventTime. */
  eventTime: string | null;
  /** Authoritative write time -- always populated. */
  recordedAt: string;
  operationId: string | null;
  createdAt: string;
}

/** One structured, cumulative treatment action. Supplements, never
 *  replaces, the free-text actionsTaken/currentStatusText fields. */
export interface IncidentTreatmentAction {
  id: string;
  incidentId: string;
  actionType: TreatmentActionType;
  /** Required and meaningful only when actionType is 'other'. */
  otherDetail: string | null;
  cycleNumber: number;
  /** `null` for actions entered during incident creation ("already
   *  performed before the incident was opened") -- no real effective
   *  time is ever collected for those, and this field is never
   *  fabricated to imply one. Actions recorded through an update or
   *  closure carry that operation's own real effective eventTime. */
  eventTime: string | null;
  recordedBy: string;
  recordedAt: string;
  operationId: string | null;
  createdAt: string;
}

/** One closure's structured classification -- tied to a specific closure
 *  cycle, never overwriteable incident-level fields. A second closure
 *  after reopening creates a SEPARATE record; the previous one is never
 *  mutated. Only ever present for a genuine (full-readiness) close --
 *  absent for a legacy close made without classification, exactly like a
 *  true legacy incident (no row = no classification recorded, same
 *  rendering for both cases). */
export interface IncidentClosureClassification {
  id: string;
  incidentId: string;
  cycleNumber: number;
  /** Shared with the 'closed' IncidentEvent row (via its refId) and any
   *  treatment action recorded inline during this same closure call. */
  operationId: string | null;
  confirmedCause: ConfirmedCause;
  /** Required and meaningful only when confirmedCause is 'other'. */
  confirmedCauseOtherDetail: string | null;
  treatmentOutcome: TreatmentOutcome;
  /** Required and meaningful only when treatmentOutcome is 'other'. */
  treatmentOutcomeOtherDetail: string | null;
  resolutionAttribution: ResolutionAttribution;
  /** Required and meaningful only when resolutionAttribution is 'other'. */
  resolutionAttributionOtherDetail: string | null;
  /** IncidentTreatmentAction ids this closure's resolutionAttribution is
   *  based on -- exactly one for 'specific_action', at least two distinct
   *  for 'combination_of_actions', always empty otherwise. */
  resolutionActionIds: string[];
  recordedBy: string;
  eventTime: string;
  recordedAt: string;
  createdAt: string;
}

export type NotificationType =
  | 'incident_assigned'
  // 'update_overdue': the next-update-ETA concept is no longer an active
  // product feature (no new row of this type is ever written), but hosted
  // databases may still contain historical rows of it. Kept in the domain
  // type and label mapping for read compatibility; both repositories filter
  // it out of active listNotifications results (see PR review follow-up).
  // Migration 0044 additionally deletes any such row server-side.
  | 'update_overdue'
  | 'incident_reopened'
  // 'handover_pending': the shift-handover feature has been removed (no new
  // row of this type is ever written), but hosted databases may still
  // contain historical rows of it. Kept in the domain type and label
  // mapping for read compatibility, exactly like 'update_overdue' above.
  | 'handover_pending'
  // Role-based operational notifications (professional_manager broadcast) --
  // added alongside the notification category split (migration 0043/0044).
  | 'incident_opened'
  | 'incident_updated'
  | 'incident_closed'
  | 'incident_cancelled';

/** Durable classification, independent of `type`: 'action_required' is a
 *  personal call to action for the recipient (assigned to you, reopened and
 *  assigned to you); 'update' is a
 *  role-based informational broadcast that requires no action. Some types
 *  (notably 'incident_reopened') can be EITHER, depending on which flow
 *  produced the row -- category is what disambiguates them, not the type
 *  alone. Always server-set; never accepted from the client. */
export type NotificationCategory = 'action_required' | 'update';

export interface AppNotification {
  id: string;
  userId: string;
  type: NotificationType;
  category: NotificationCategory;
  incidentId: string | null;
  /** Set only on historical 'handover_pending' rows from the now-removed
   *  shift-handover feature; always null going forward. */
  handoverId: string | null;
  text: string;
  read: boolean;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  actorId: string | null;
  /** Snapshot of the acting profile's full name at write time -- independent of a later rename. */
  actorDisplayName: string | null;
  /** Snapshot of the acting user's email at write time, where available. */
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string;
  /** Human-readable label for entityId (a name, a full name, an incident number, ...), where useful. */
  entityLabel: string | null;
  /** Optional free-text summary for actions whose relevant detail is not just a field diff. */
  summary: string | null;
  incidentNumber: string | null;
  before: string | null; // JSON string
  after: string | null; // JSON string
  /** Optional structured context beyond before/after. */
  metadata: string | null; // JSON string
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
