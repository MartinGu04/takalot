// Repository abstraction. Implementations: LocalDemoRepository (demo mode, enforcing
// backend rules in-process) and SupabaseRepository (production-ready data layer).
import type {
  AppNotification,
  AuditLog,
  Handover,
  HandoverAddendum,
  HandoverItem,
  Incident,
  IncidentEvent,
  IncidentStatus,
  IncidentUpdate,
  LocationRecord,
  PendingPersonnel,
  PersonnelEntry,
  Profile,
  ReportedToOps,
  Role,
  Severity,
  SystemRecord,
} from '../domain/types';
import type {
  AssignIncidentInput,
  CancelIncidentInput,
  CloseIncidentInput,
  CorrectionInput,
  CreateHandoverInput,
  CreateIncidentInput,
  PendingPersonnelInput,
  ReopenIncidentInput,
  TechnicianUpdateInput,
  UpdateIncidentInput,
} from '../domain/schemas';

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
  | 'DELETE_INCOMPLETE';

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
  overdueOnly?: boolean;
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
  incidentNumber?: string;
  from?: string;
  to?: string;
}

export interface Session {
  userId: string;
  role: Role;
}

export interface ExportAuditInfo {
  exportType: 'incident_pdf' | 'handover_pdf' | 'incidents_xlsx' | 'incidents_csv';
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
  createSystem(session: Session, name: string): Promise<SystemRecord>;
  renameSystem(session: Session, id: string, name: string): Promise<void>;
  setSystemArchived(session: Session, id: string, archived: boolean): Promise<void>;
  moveSystem(session: Session, id: string, direction: ReferenceDataMoveDirection): Promise<void>;
  deleteSystem(session: Session, id: string): Promise<ReferenceDataDeleteOutcome>;
  createLocation(session: Session, name: string): Promise<LocationRecord>;
  renameLocation(session: Session, id: string, name: string): Promise<void>;
  setLocationArchived(session: Session, id: string, archived: boolean): Promise<void>;
  moveLocation(session: Session, id: string, direction: ReferenceDataMoveDirection): Promise<void>;
  deleteLocation(session: Session, id: string): Promise<ReferenceDataDeleteOutcome>;

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

  // --- pre-provisioned personnel (supabase-mode onboarding) ---
  listPendingPersonnel(session: Session): Promise<PendingPersonnel[]>;
  createPendingPersonnel(session: Session, input: PendingPersonnelInput): Promise<PendingPersonnel>;
  updatePendingPersonnel(session: Session, id: string, input: PendingPersonnelInput): Promise<PendingPersonnel>;
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
  getIncident(session: Session, id: string): Promise<Incident | null>;
  getIncidentEvents(session: Session, incidentId: string): Promise<IncidentEvent[]>;
  getIncidentUpdates(session: Session, incidentId: string): Promise<IncidentUpdate[]>;
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

  // --- handovers ---
  listHandovers(session: Session): Promise<Handover[]>;
  getHandover(session: Session, id: string): Promise<{
    handover: Handover;
    items: HandoverItem[];
    addenda: HandoverAddendum[];
  } | null>;
  createHandover(session: Session, input: CreateHandoverInput): Promise<Handover>;
  acceptHandover(session: Session, handoverId: string): Promise<Handover>;
  addHandoverAddendum(session: Session, handoverId: string, text: string): Promise<void>;

  // --- notifications ---
  listNotifications(session: Session): Promise<AppNotification[]>;
  markNotificationRead(session: Session, id: string): Promise<void>;
  markAllNotificationsRead(session: Session): Promise<void>;

  // --- audit ---
  listAuditLogs(session: Session, filters?: AuditFilters): Promise<AuditLog[]>;
  recordExport(session: Session, info: ExportAuditInfo): Promise<void>;

  /** Permission check that mirrors backend policy (used by UI and export layer). */
  canExport(session: Session): Promise<boolean>;
}
