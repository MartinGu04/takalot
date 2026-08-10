// Repository abstraction. Implementations: LocalDemoRepository (demo mode, enforcing
// backend rules in-process) and SupabaseRepository (production-ready data layer).
import type {
  AppNotification,
  AuditLog,
  Incident,
  IncidentCauseAssessment,
  IncidentClosureClassification,
  IncidentDomain,
  IncidentEvent,
  IncidentRelation,
  IncidentStatus,
  IncidentSummary,
  IncidentTreatmentAction,
  IncidentUpdate,
  LocationCategory,
  LocationRecord,
  OperationalNotificationEventType,
  OperationalNotificationPreference,
  PendingPersonnel,
  PersonnelEntry,
  Profile,
  ReportedToOps,
  Role,
  Severity,
  SimilarIncidentSuggestion,
  SystemCategory,
  SystemRecord,
} from '../domain/types';
import type {
  AssignIncidentInput,
  CancelIncidentInput,
  CloseIncidentInput,
  CorrectionInput,
  CreateIncidentInput,
  PendingPersonnelInput,
  RenamePersonnelInput,
  ReopenIncidentInput,
  TechnicianUpdateInput,
  UpdateIncidentInput,
} from '../domain/schemas';
// Re-exported here (not just imported) so callers of the Repository
// interface can pull the ניתוחים (analytics) filter/result shapes from the
// same place as every other repository-adjacent type, even though they are
// defined in the domain layer -- see analyticsSummary.ts for why the
// domain module owns these types rather than this file.
export type {
  AnalyticsBucketUnit,
  AnalyticsEntityFilters,
  AnalyticsFilters,
  AnalyticsPeriodDays,
  IncidentAnalytics,
} from '../domain/analyticsSummary';
import type { AnalyticsBucketUnit, AnalyticsEntityFilters, AnalyticsFilters, IncidentAnalytics } from '../domain/analyticsSummary';
export type { IncidentOpenBacklog } from '../domain/analyticsOpenBacklog';
import type { IncidentOpenBacklog } from '../domain/analyticsOpenBacklog';
export type { AnalyticsEnumCount, IncidentClosureInsights } from '../domain/analyticsClosureInsights';
import type { IncidentClosureInsights } from '../domain/analyticsClosureInsights';
export type { AnalyticsModuleKey } from '../domain/analyticsPreferences';
import type { AnalyticsModuleKey } from '../domain/analyticsPreferences';
export type { TrendBucketIncidents } from '../domain/analyticsTrendDrilldown';
import type { TrendBucketIncidents } from '../domain/analyticsTrendDrilldown';

export type ErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT' // optimistic concurrency: incident changed since page load
  | 'INVALID_TRANSITION'
  | 'SESSION_EXPIRED'
  | 'NETWORK'
  // The profile was deactivated and tombstoned successfully, but deleting
  // the Auth account failed and must be retried (server-side delete-user
  // flow). Distinct from NETWORK: the DB step already succeeded.
  | 'DELETE_INCOMPLETE'
  // linkIncidentOnCreation only: the suggested incident closed/cancelled
  // between the suggestion being shown and this call. Distinct from a
  // generic failure -- the incident being created is NEVER affected by
  // this, and the UI shows a specific, non-alarming message ("can be
  // linked later by a supervisor") rather than a scary error.
  | 'STALE_TARGET';

/** Application error with a user-facing Hebrew message. */
export class AppError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'AppError';
  }
}

export interface IncidentFilters {
  search?: string;
  status?: IncidentStatus[];
  severity?: Severity[];
  ownerUserId?: string;
  systemId?: string;
  locationId?: string;
  reportedToOps?: ReportedToOps;
  createdFrom?: string; // ISO
  createdTo?: string; // ISO
  /** Archive scope: both terminal outcomes -- 'closed' and 'cancelled' --
   *  not literally status = 'closed'. A cancelled incident has no
   *  root-cause/resolution/readiness data, so readiness/root-cause/
   *  resolution-text filters naturally exclude it when active, exactly as
   *  they would for any other incident missing that data. */
  terminalOnly?: boolean;
  openOnly?: boolean;
  readinessAtClose?: ('full' | 'partial' | 'none')[];
  rootCauseText?: string;
  resolutionText?: string;
  followUpPending?: boolean;
}

export type IncidentSort = 'priority' | 'newest' | 'oldest' | 'next_update' | 'last_update';

export interface AuditFilters {
  actorId?: string;
  action?: string;
  entityType?: string;
  from?: string; // ISO
  to?: string; // ISO
  /** Free-text search across entity label, incident number, and summary. */
  search?: string;
}

export interface AuditLogPage {
  items: AuditLog[];
  /** Total rows matching the filters, independent of the current page size. */
  total: number;
}

export interface Session {
  userId: string;
  role: Role;
}

export interface ExportAuditInfo {
  exportType: 'incident_pdf' | 'incidents_xlsx' | 'incidents_csv';
  filtersDescription: string;
}

export type ReferenceDataMoveDirection = 'up' | 'down';
export type ReferenceDataDeleteOutcome = 'deleted' | 'archived';

export interface Repository {
  readonly mode: 'demo' | 'supabase';

  // --- session / profiles ---
  listProfiles(session: Session): Promise<Profile[]>;
  getProfile(userId: string): Promise<Profile | null>;

  // --- configuration ---
  listSystems(): Promise<SystemRecord[]>;
  listLocations(): Promise<LocationRecord[]>;
  createSystem(session: Session, name: string, category: SystemCategory): Promise<SystemRecord>;
  renameSystem(session: Session, id: string, name: string): Promise<void>;
  setSystemArchived(session: Session, id: string, archived: boolean): Promise<void>;
  moveSystem(session: Session, id: string, direction: ReferenceDataMoveDirection): Promise<void>;
  deleteSystem(session: Session, id: string): Promise<ReferenceDataDeleteOutcome>;
  /**
   * Persists a complete drag-and-drop reorder in one call: orderedIds must be
   * exactly the full set of existing system ids WITHIN ONE CATEGORY (no
   * fewer, no more, no duplicates, and never spanning more than one
   * category), in their new display order. Replaces a sequence of
   * move_system calls, which only ever swap one adjacent pair at a time and
   * so cannot safely commit an arbitrary final order atomically. Ordering is
   * scoped per category -- this can never move a record into a different
   * category; use setSystemCategory for that.
   */
  reorderSystems(session: Session, orderedIds: string[]): Promise<void>;
  /**
   * Moves a system to a different category, appended to the end of that
   * category's display order. Transactional and enforced server-side; a
   * no-op when `category` already matches the record's current category.
   * Never changes the record's id, name, or active/archived state.
   */
  setSystemCategory(session: Session, id: string, category: SystemCategory): Promise<void>;
  createLocation(session: Session, name: string, category: LocationCategory): Promise<LocationRecord>;
  renameLocation(session: Session, id: string, name: string): Promise<void>;
  setLocationArchived(session: Session, id: string, archived: boolean): Promise<void>;
  moveLocation(session: Session, id: string, direction: ReferenceDataMoveDirection): Promise<void>;
  deleteLocation(session: Session, id: string): Promise<ReferenceDataDeleteOutcome>;
  /** Same contract as reorderSystems, for locations. */
  reorderLocations(session: Session, orderedIds: string[]): Promise<void>;
  /** Same contract as setSystemCategory, for locations. */
  setLocationCategory(session: Session, id: string, category: LocationCategory): Promise<void>;

  // --- linked-personnel management (role ceilings enforced in the database) ---
  setUserRole(session: Session, userId: string, role: Role): Promise<void>;
  setUserActive(session: Session, userId: string, active: boolean): Promise<void>;
  /**
   * Permanently deletes login access for a linked profile: deactivates and
   * tombstones the profile, then (supabase mode, via the server-side
   * delete-user function) deletes the Supabase Auth account. Does not
   * remove or anonymize any historical data -- incidents, updates,
   * events, notifications, and audit entries keep referencing the
   * permanent profile row exactly as before. Idempotent: calling this
   * again on an already-deleted profile is a safe no-op (useful for
   * retrying after a DELETE_INCOMPLETE error). The database/Edge Function
   * is the real authorization boundary; the frontend only hides the
   * action when it already knows it would be rejected.
   */
  deleteUser(session: Session, userId: string): Promise<void>;
  /**
   * Renames an already-linked profile (active or inactive). Same role
   * ceilings and self-exclusion as setUserRole/setUserActive; a
   * tombstoned ('deleted') profile is rejected. Never touches role,
   * active state, or anything else -- name only.
   */
  renameLinkedPersonnel(session: Session, userId: string, input: RenamePersonnelInput): Promise<void>;

  // --- pre-provisioned personnel (supabase-mode onboarding) ---
  listPendingPersonnel(session: Session): Promise<PendingPersonnel[]>;
  createPendingPersonnel(session: Session, input: PendingPersonnelInput): Promise<PendingPersonnel>;
  updatePendingPersonnel(session: Session, id: string, input: PendingPersonnelInput): Promise<PendingPersonnel>;
  /**
   * Renames a pending entry only -- the same role ceiling as
   * createPendingPersonnel/updatePendingPersonnel, but touches only the
   * name. The renamed value is what claimPendingProfile() later uses when
   * the person signs in for the first time.
   */
  renamePendingPersonnel(session: Session, id: string, input: RenamePersonnelInput): Promise<PendingPersonnel>;
  cancelPendingPersonnel(session: Session, id: string): Promise<void>;
  /**
   * Attempts to claim the authenticated identity's matching pending entry.
   * Takes no identity/email arguments by design: the backend derives
   * auth.uid() and the verified email itself. Returns the resulting (or
   * already-existing) profile, or null when nothing matches -- the caller
   * stays unauthorized in that case.
   */
  claimPendingProfile(): Promise<Profile | null>;
  /**
   * Unified management-safe listing of pending entries AND already-linked
   * profiles (with their normalized Google emails, resolved server-side --
   * the client never queries auth.users). Restricted to shift_supervisor /
   * professional_manager / system_admin; everyone else is rejected.
   */
  listPersonnel(session: Session): Promise<PersonnelEntry[]>;
  /**
   * One-time first-administrator bootstrap for a fresh database (no
   * profiles at all). Takes no arguments by design: the backend verifies
   * the confirmed Google identity server-side against a server-side-only
   * configured email, succeeds at most once ever, and fails closed
   * (null) in every other case. Not a self-registration path -- every
   * later user goes through pending_personnel.
   */
  bootstrapFirstAdmin(): Promise<Profile | null>;
  /**
   * Best-effort persistence of the CALLER's OWN avatar image URL, from
   * data their own already-authenticated session already holds -- never
   * reads or exposes auth.users, and never touches any field but
   * avatar_url on the caller's own row. Safe to call whenever a fresher
   * value is available (e.g. every sign-in); never blocks or fails the
   * surrounding auth flow.
   */
  setOwnAvatarUrl(avatarUrl: string | null): Promise<void>;
  /**
   * Self-only read of the CALLER's own EFFECTIVE per-event operational
   * notification preferences (AVARIA v1.6.0, migration 0058) -- always
   * exactly five rows (one per OperationalNotificationEventType), each the
   * merge of the fixed default matrix with any explicit override, never
   * the raw override alone. Restricted server-side to an active
   * system_admin/professional_manager/shift_supervisor (is_operational_role());
   * every other role is rejected. Supersedes the removed
   * setMyOperationalNotificationsEnabled -- see Profile.operationalNotificationsEnabled's
   * own deprecation note.
   */
  getMyOperationalNotificationPreferences(session: Session): Promise<OperationalNotificationPreference[]>;
  /**
   * Self-only write of ONE per-event preference override. Takes no user
   * id: the target is always the CALLER's own profile, derived
   * server-side from auth.uid(). action_required notifications are never
   * covered by this -- eventType only ever accepts one of the five
   * OperationalNotificationEventType values, never an action_required
   * type. pushEnabled is server-normalized to false whenever inAppEnabled
   * is false ("Push requires in-app", a hard DB invariant, not just a UI
   * convention). Returns the caller's full, freshly-resolved five-row
   * effective set, so the UI can refresh its cache from a single round
   * trip.
   */
  setMyOperationalNotificationPreference(
    session: Session,
    eventType: OperationalNotificationEventType,
    prefs: { inAppEnabled: boolean; pushEnabled: boolean },
  ): Promise<OperationalNotificationPreference[]>;

  // --- push subscriptions (self-service, device-local; see migration 0053) ---
  /**
   * Attaches (or, on a shared browser reusing an endpoint another AVARIA
   * account previously owned, reassigns) a Web Push subscription to the
   * CALLER's own account. endpoint/p256dh/auth are taken verbatim from the
   * browser's own PushSubscription -- never generated or altered here.
   * Idempotent: saving the same endpoint again (e.g. a refreshed key)
   * simply updates the existing row.
   */
  savePushSubscription(session: Session, endpoint: string, keys: { p256dh: string; auth: string }): Promise<void>;
  /**
   * Detaches exactly the CALLER's own subscription matching this endpoint.
   * A no-op (not an error) when the endpoint belongs to someone else or no
   * longer exists -- mirrors delete_my_push_subscription's WHERE-scoped
   * delete, which can never touch another account's row.
   */
  deletePushSubscription(session: Session, endpoint: string): Promise<void>;
  /** Detaches every Push subscription the caller owns, across every device
   *  ("נתק את כל המכשירים"). Never touches another account's subscriptions. */
  deleteAllPushSubscriptions(session: Session): Promise<void>;
  /** Count of the caller's own Push subscriptions, across every device --
   *  never endpoints or key material, and never another user's count. */
  countPushSubscriptions(session: Session): Promise<number>;
  /**
   * True only when this exact browser endpoint is CURRENTLY attached to the
   * caller's own account. Guards the shared-browser case: a browser can
   * hold a real PushSubscription whose endpoint is registered to a
   * DIFFERENT AVARIA account (e.g. a previous, incompletely-logged-out
   * user on the same device) -- the UI must not report the current device
   * as enabled for this caller unless this returns true.
   */
  isMyPushSubscription(session: Session, endpoint: string): Promise<boolean>;

  // --- incidents ---
  listIncidents(session: Session, filters?: IncidentFilters, sort?: IncidentSort): Promise<Incident[]>;
  /**
   * Total number of incidents whose lifecycle state is literally 'closed'.
   * Deliberately NOT derived from listIncidents: that call is capped at 500
   * rows, so counting its result would silently under-report, and its
   * terminal scope includes cancelled incidents, which are a different
   * outcome and are never counted here.
   */
  countClosedIncidents(session: Session): Promise<number>;
  /**
   * Aggregate KPIs/chart/top-systems for the ניתוחים (analytics) page.
   * Deliberately NOT derived from listIncidents(): several of these metrics
   * (currently-open counts/durations) must reflect the true, unbounded
   * current set, which the 500-row cap on listIncidents cannot safely
   * represent. In production this calls a single Postgres RPC
   * (get_incident_analytics_v2, migration 0051) that is the actual
   * calculation authority; the local/demo repository computes the same
   * documented rules in-memory via src/domain/analyticsSummary.ts, which
   * exists only to power demo mode and is not itself the source of truth.
   * Method name/shape kept stable across v1.4.0 even though the underlying
   * SQL function is a new, distinctly-named one (get_incident_analytics_v2,
   * not the original get_incident_analytics -- see that migration's header
   * for why a same-signature `create or replace` was rejected as unsafe);
   * that versioning is purely internal to SupabaseRepository.
   */
  getIncidentAnalytics(session: Session, filters: AnalyticsFilters): Promise<IncidentAnalytics>;
  /**
   * Open-incident age distribution for the ניתוחים page's backlog module.
   * Deliberately NOT period-bound (no periodDays in AnalyticsEntityFilters) --
   * matches getIncidentAnalytics's own currentlyOpen/avgOpenMinutes
   * semantics. Backed by get_incident_open_backlog (migration 0051) in
   * production; src/domain/analyticsOpenBacklog.ts in demo mode.
   */
  getIncidentOpenBacklog(session: Session, filters: AnalyticsEntityFilters): Promise<IncidentOpenBacklog>;
  /**
   * Confirmed-cause / treatment-outcome breakdown for the ניתוחים page's
   * closure-insights module. The response also carries closure-scoped
   * external-involvement counts, kept as-is in the data contract though the
   * frontend's external-involvement module (and its use of those fields)
   * was removed -- see analyticsPreferences.ts. Backed by
   * get_incident_closure_insights (migration 0051) in production;
   * src/domain/analyticsClosureInsights.ts in demo mode. The one analytics
   * fetch the frontend genuinely skips when its personalizable module
   * ('closures') is hidden -- see useIncidentClosureInsights.
   */
  getIncidentClosureInsights(session: Session, filters: AnalyticsFilters): Promise<IncidentClosureInsights>;
  /**
   * The caller's own stored analytics module-visibility preference, or
   * `null` when none is stored (use the role default -- see
   * src/domain/analyticsPreferences.ts). A direct RLS-scoped read, no RPC:
   * an ineligible role (technician/viewer) always reads null, never an
   * error, since the RLS policy silently excludes their row even if one
   * somehow existed.
   */
  getAnalyticsPreferences(session: Session): Promise<AnalyticsModuleKey[] | null>;
  /**
   * Sets (or, with `modules = null`, resets to the role default) the
   * caller's OWN analytics module visibility -- self-only by construction,
   * no user_id parameter exists to target anyone else. Restricted to
   * shift_supervisor and above, enforced server-side (RLS + the RPC's own
   * is_operational_role() check, migration 0052) -- being authenticated is
   * explicitly not sufficient; a technician/viewer call is rejected with a
   * controlled FORBIDDEN error, not merely hidden in the UI.
   */
  setAnalyticsVisibleModules(session: Session, modules: AnalyticsModuleKey[] | null): Promise<void>;
  /**
   * Bounded (TREND_BUCKET_DRILLDOWN_LIMIT rows per section, server-side)
   * incident summaries for exactly ONE trend-chart bucket -- the "לחץ
   * לצפייה בתקלות" drill-down. `bucketStart`/`bucketUnit` MUST be the exact
   * values the chart itself rendered that bucket from (bucketUnit is
   * `bucketUnitForPeriod(filters.periodDays)`, matching the trend's own
   * day/week rule) -- this is what guarantees the returned incidents can
   * never contradict the chart's own opened/closed counts for that bucket:
   * both are built from the same matchesEntityFilters/bucketKeyOf rules
   * (src/domain/analyticsSummary.ts). Filters are entity-only (no
   * periodDays) since the bucket itself already pins the exact window.
   * Fetched only on demand, once a bucket is clicked -- never as part of
   * the normal analytics page load. No dedicated RPC/migration: both
   * implementations read directly from the same RLS-gated (is_active_member())
   * incidents/incident_closures tables every other bounded incident query in
   * this repository already uses (see supabaseRepository.ts for the exact
   * query shape and why it preserves the trend's semantics exactly).
   */
  getAnalyticsTrendBucketIncidents(
    session: Session,
    bucketStart: string,
    bucketUnit: AnalyticsBucketUnit,
    filters: AnalyticsEntityFilters,
  ): Promise<TrendBucketIncidents>;
  getIncident(session: Session, id: string): Promise<Incident | null>;
  getIncidentEvents(session: Session, incidentId: string): Promise<IncidentEvent[]>;
  getIncidentUpdates(session: Session, incidentId: string): Promise<IncidentUpdate[]>;
  /** Full structured-cause-assessment history for one incident, across
   *  every closure cycle -- used to render the Timeline's inline
   *  creation-card assessment and every later cause_assessment_changed
   *  event's context. */
  getIncidentCauseAssessments(session: Session, incidentId: string): Promise<IncidentCauseAssessment[]>;
  /** Every structured treatment action recorded for one incident, across
   *  every closure cycle -- used by the Timeline (joined by operationId
   *  onto the event that recorded them) and by CloseDialog's action
   *  picker (filtered to the current cycle). */
  getIncidentTreatmentActions(session: Session, incidentId: string): Promise<IncidentTreatmentAction[]>;
  /** Every closure classification recorded for one incident -- one row
   *  per genuine (full-readiness) closure cycle; absent for a cycle
   *  closed without structured classification (legacy incident, or a
   *  closure made through the still-permissive legacy close_incident
   *  RPC). */
  getIncidentClosures(session: Session, incidentId: string): Promise<IncidentClosureClassification[]>;
  createIncident(session: Session, input: CreateIncidentInput): Promise<Incident>;
  acknowledgeIncident(session: Session, incidentId: string, expectedVersion: number): Promise<Incident>;
  updateIncident(session: Session, incidentId: string, input: UpdateIncidentInput): Promise<Incident>;
  technicianUpdate(session: Session, incidentId: string, input: TechnicianUpdateInput): Promise<Incident>;
  assignIncident(session: Session, incidentId: string, input: AssignIncidentInput): Promise<Incident>;
  closeIncident(session: Session, incidentId: string, input: CloseIncidentInput): Promise<Incident>;
  cancelIncident(session: Session, incidentId: string, input: CancelIncidentInput): Promise<Incident>;
  reopenIncident(session: Session, incidentId: string, input: ReopenIncidentInput): Promise<Incident>;
  addCorrection(session: Session, incidentId: string, input: CorrectionInput): Promise<void>;
  completeFollowUp(session: Session, incidentId: string, note: string): Promise<Incident>;

  // --- related incidents ---
  /**
   * Up to 3 bounded, server-scored candidates for the incident-creation
   * suggestion block. Description similarity is a mandatory gate -- never
   * "same system alone" -- see supabase/migrations/0050 (production) /
   * src/domain/similarity.ts (demo mode) for the exact algorithm both
   * independently implement. Purely a recommendation: never creates any
   * relationship by itself.
   */
  suggestSimilarIncidents(
    session: Session,
    query: { systemId: string; locationId: string | null; reportedDomain: IncidentDomain | null; description: string },
  ): Promise<SimilarIncidentSuggestion[]>;
  /** Every explicit relation for one incident, from that incident's own
   *  point of view -- symmetric by construction (see IncidentRelation). */
  getIncidentRelations(session: Session, incidentId: string): Promise<IncidentRelation[]>;
  /**
   * Links a JUST-created incident to a suggested one. Only ever callable by
   * the incident's own creator, and only within a short window after
   * creation (server-enforced, not merely UI-hidden) -- never a standing
   * permission. Throws AppError('STALE_TARGET', ...) if the related
   * incident closed/cancelled since the suggestion was shown; the caller
   * (already-created incident) is never affected by that failure.
   */
  linkIncidentOnCreation(session: Session, newIncidentId: string, relatedIncidentId: string): Promise<void>;
  /**
   * Post-creation relation management -- add or remove, on any incident
   * pair, restricted to manage_incident_relations (אחמ״ש ומעלה). Idempotent:
   * linking an already-linked pair, or unlinking an already-absent one, is
   * a silent success (no duplicate/phantom audit event), the least noisy
   * behavior for a possible double-submission.
   */
  manageIncidentRelation(
    session: Session,
    incidentId: string,
    relatedIncidentId: string,
    action: 'link' | 'unlink',
  ): Promise<void>;
  /**
   * Bounded (max 10 rows, server-side) manual search for the "קישור תקלה
   * קשורה" picker -- manage_incident_relations only, requires a meaningful
   * (>=2 char) query, excludes the current incident, and deliberately
   * reaches closed/cancelled incidents too (manual linking may intend that
   * on purpose, unlike the suggestion path above).
   */
  searchIncidentsForRelation(session: Session, query: string, excludeIncidentId: string): Promise<IncidentSummary[]>;

  // --- notifications ---
  listNotifications(session: Session): Promise<AppNotification[]>;
  markNotificationRead(session: Session, id: string): Promise<void>;
  markAllNotificationsRead(session: Session): Promise<void>;
  /** Persistently dismisses every currently-active notification for the
   *  authenticated user (נקה הכל) -- not equivalent to marking read. Cleared
   *  rows are preserved, never deleted, and simply excluded from
   *  listNotifications going forward; a notification created afterward is
   *  unaffected and appears normally. */
  clearNotifications(session: Session): Promise<void>;

  // --- audit ---
  /**
   * Bounded, server-side-paginated read of the system-wide audit log.
   * page is 1-based; pageSize is clamped server-side (supabase mode) to a
   * hard maximum regardless of what is requested -- never an unbounded
   * history fetch. Restricted to professional_manager/system_admin at the
   * database level independent of this method's own FORBIDDEN check.
   */
  listAuditLogs(session: Session, filters: AuditFilters, page: number, pageSize: number): Promise<AuditLogPage>;
  recordExport(session: Session, info: ExportAuditInfo): Promise<void>;

  /** Permission check that mirrors backend policy (used by UI and export layer). */
  canExport(session: Session): Promise<boolean>;
}
