// SupabaseRepository: production-ready data layer wired to the SQL schema in
// /supabase/migrations. Authorization is enforced by RLS policies and SECURITY
// DEFINER RPCs in the database — not by this client code.
import type { SupabaseClient } from '@supabase/supabase-js';
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
  InvitationSendOutcome,
  LocationCategory,
  LocationRecord,
  OperationalNotificationEventType,
  OperationalNotificationPreference,
  PendingPersonnel,
  PersonnelEntry,
  Profile,
  Role,
  Severity,
  SimilarIncidentSuggestion,
  SystemCategory,
  SystemRecord,
} from '../../domain/types';
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
} from '../../domain/schemas';
import { AppError } from '../repository';
import type {
  AnalyticsBucketUnit,
  AnalyticsEntityFilters,
  AnalyticsFilters,
  AnalyticsModuleKey,
  AuditFilters,
  AuditLogPage,
  ExportAuditInfo,
  IncidentAnalytics,
  IncidentClosureInsights,
  IncidentFilters,
  IncidentOpenBacklog,
  IncidentSort,
  ReferenceDataDeleteOutcome,
  ReferenceDataMoveDirection,
  Repository,
  Session,
  TrendBucketIncidents,
} from '../repository';
import { sortByPriority } from '../../domain/overdue';
import { addDays, jerusalemMidnightIso } from '../../domain/analyticsSummary';
import { TREND_BUCKET_DRILLDOWN_LIMIT } from '../../domain/analyticsTrendDrilldown';

// Maps a failed delete-user Edge Function invocation to an AppError. The
// function's response body is JSON ({ error, message, retryable? }); a
// FunctionsHttpError's `context` is the raw fetch Response, so the body
// must be read asynchronously. Status codes are stable and checked first;
// the safe business message from a 409 (validation, e.g. the open-
// incident guard) is the only server-provided text ever surfaced to the
// user -- everything else gets a fixed Hebrew message here, never the
// function's raw (English, internal) text.
async function mapDeleteUserError(error: unknown): Promise<AppError> {
  const context = (error as { context?: unknown } | null | undefined)?.context;
  let status: number | undefined;
  let body: { error?: string; message?: string } | undefined;
  if (context && typeof context === 'object' && 'status' in context) {
    status = (context as { status?: number }).status;
    try {
      body = await (context as Response).json();
    } catch {
      // No JSON body available -- fall through to the generic mapping below.
    }
  }

  if (status === 403) {
    return new AppError('FORBIDDEN', 'אין לך הרשאה מספקת למחוק משתמש זה.');
  }
  if (status === 404) {
    return new AppError('NOT_FOUND', 'המשתמש כבר אינו קיים.');
  }
  if (status === 409) {
    return new AppError('VALIDATION', body?.message || 'לא ניתן למחוק את המשתמש כעת.');
  }
  if (status === 502 && body?.error === 'auth_delete_failed') {
    return new AppError(
      'DELETE_INCOMPLETE',
      'המשתמש הושבת ונחסם בבטחה, אך מחיקת חשבון ההתחברות נכשלה. יש לנסות שוב.',
    );
  }
  return new AppError('NETWORK', 'אירעה שגיאה בלתי צפויה במחיקת המשתמש. נא לנסות שוב.');
}

// Maps a failed send-invitation-email Edge Function INVOCATION (missing
// auth, the caller out of role-ceiling for this entry, the entry no
// longer a valid invitation target, or the function's own environment
// being misconfigured) to an AppError -- distinct from the function's
// normal 200 response, which reports a failed SEND as
// { outcome: 'failed', message } data, not an error (see
// sendPersonnelInvitation below). Same status-code-first, safe-body-only
// mapping as mapDeleteUserError.
async function mapInvitationError(error: unknown): Promise<AppError> {
  const context = (error as { context?: unknown } | null | undefined)?.context;
  let status: number | undefined;
  let body: { error?: string; message?: string } | undefined;
  if (context && typeof context === 'object' && 'status' in context) {
    status = (context as { status?: number }).status;
    try {
      body = await (context as Response).json();
    } catch {
      // No JSON body available -- fall through to the generic mapping below.
    }
  }

  if (status === 403) {
    return new AppError('FORBIDDEN', 'אין לך הרשאה לשלוח הזמנה לרישום זה.');
  }
  if (status === 404) {
    return new AppError('NOT_FOUND', 'הרישום לא נמצא.');
  }
  if (status === 409) {
    return new AppError('VALIDATION', body?.message || 'ניתן לשלוח הזמנה רק לרישום הממתין להתחברות.');
  }
  return new AppError('NETWORK', 'אירעה שגיאה בלתי צפויה בשליחת ההזמנה. נא לנסות שוב.');
}

function wrap(error: { message: string; code?: string } | null): void {
  if (!error) return;
  if (error.code === 'PGRST301' || /jwt/i.test(error.message)) {
    throw new AppError('SESSION_EXPIRED', 'פג תוקף ההתחברות. יש להתחבר מחדש.');
  }
  if (error.code === '42501' || /permission|policy/i.test(error.message)) {
    throw new AppError('FORBIDDEN', 'אין לך הרשאה לבצע פעולה זו.');
  }
  if (/version_conflict/.test(error.message)) {
    throw new AppError('CONFLICT', 'התקלה עודכנה על ידי משתמש אחר. יש לרענן את הדף לפני שמירה.');
  }
  if (/invalid_transition/.test(error.message)) {
    throw new AppError('INVALID_TRANSITION', error.message.replace(/^.*invalid_transition:\s*/, ''));
  }
  if (/validation:/.test(error.message)) {
    throw new AppError('VALIDATION', error.message.replace(/^.*validation:\s*/, ''));
  }
  if (/not_found:/.test(error.message)) {
    throw new AppError('NOT_FOUND', error.message.replace(/^.*not_found:\s*/, ''));
  }
  if (/stale_target:/.test(error.message)) {
    throw new AppError('STALE_TARGET', error.message.replace(/^.*stale_target:\s*/, ''));
  }
  throw new AppError('NETWORK', `שגיאת תקשורת מול השרת: ${error.message}`);
}

function wrapReferenceData(error: { message: string; code?: string } | null): void {
  if (!error) return;
  if (/conflict:/.test(error.message)) {
    throw new AppError('CONFLICT', error.message.replace(/^.*conflict:\s*/, ''));
  }
  try {
    wrap(error);
  } catch (wrappedError) {
    if (wrappedError instanceof AppError && wrappedError.code !== 'NETWORK') {
      throw wrappedError;
    }
    throw new AppError(
      'NETWORK',
      'אירעה שגיאה בלתי צפויה מול השרת. הנתונים לא נשמרו — ניתן לנסות שוב.',
    );
  }
}

// snake_case rows → camelCase domain objects. Exported (not just used
// internally) so the exact same mapping logic can be reused wherever raw
// snake_case rows are read outside a live SupabaseClient -- e.g. an
// integration test running these queries directly against a local
// Postgres instance via psql, verifying the real mapper output against
// the real RPC/schema, not a reimplementation of it.
export const mapIncident = (r: Record<string, unknown>): Incident => ({
  id: r.id as string,
  number: r.number as string,
  version: r.version as number,
  systemId: r.system_id as string,
  locationId: r.location_id as string,
  description: r.description as string,
  severity: r.severity as Incident['severity'],
  status: r.status as Incident['status'],
  operationalImpact: r.operational_impact as string,
  ownerUserId: r.owner_user_id as string | null,
  ownerExternalName: r.owner_external_name as string | null,
  externalHandlerName: r.external_handler_name as string | null,
  externalHandlerContactPerson: r.external_handler_contact_person as string | null,
  externalHandlerContactDetails: r.external_handler_contact_details as string | null,
  discoveredAt: r.discovered_at as string,
  createdAt: r.created_at as string,
  createdBy: r.created_by as string,
  updatedAt: r.updated_at as string,
  updatedBy: r.updated_by as string,
  lastUpdateAt: r.last_update_at as string,
  nextUpdateDue: r.next_update_due as string | null,
  noDeadlineReason: r.no_deadline_reason as string | null,
  reportedToOps: r.reported_to_ops as Incident['reportedToOps'],
  reportedToOpsRecipient: r.reported_to_ops_recipient as string | null,
  reportedToComms: r.reported_to_comms as boolean,
  reportedToCommsRecipient: r.reported_to_comms_recipient as string | null,
  wisdomReported: r.wisdom_reported as boolean,
  wisdomIncidentNumber: r.wisdom_incident_number as string | null,
  closedAt: r.closed_at as string | null,
  closedBy: r.closed_by as string | null,
  rootCause: r.root_cause as string | null,
  resolution: r.resolution as string | null,
  readinessAtClose: r.readiness_at_close as Incident['readinessAtClose'],
  followUpNotes: r.follow_up_notes as string | null,
  followUpRequired: r.follow_up_required as boolean,
  followUpCompletedAt: r.follow_up_completed_at as string | null,
  followUpCompletedBy: r.follow_up_completed_by as string | null,
  reopenCount: r.reopen_count as number,
  cancelledAt: r.cancelled_at as string | null,
  cancelledBy: r.cancelled_by as string | null,
  cancellationReason: r.cancellation_reason as string | null,
  reportedDomain: r.reported_domain as Incident['reportedDomain'],
  currentSuspectedCause: r.current_suspected_cause as Incident['currentSuspectedCause'],
  currentSuspectedCauseOtherDetail: r.current_suspected_cause_other_detail as string | null,
});

export const mapCauseAssessment = (r: Record<string, unknown>): IncidentCauseAssessment => ({
  id: r.id as string,
  incidentId: r.incident_id as string,
  cause: r.cause as IncidentCauseAssessment['cause'],
  otherDetail: r.other_detail as string | null,
  cycleNumber: r.cycle_number as number,
  recordedBy: r.recorded_by as string,
  eventTime: r.event_time as string | null,
  recordedAt: r.recorded_at as string,
  operationId: r.operation_id as string | null,
  createdAt: r.created_at as string,
});

export const mapTreatmentAction = (r: Record<string, unknown>): IncidentTreatmentAction => ({
  id: r.id as string,
  incidentId: r.incident_id as string,
  actionType: r.action_type as IncidentTreatmentAction['actionType'],
  otherDetail: r.other_detail as string | null,
  cycleNumber: r.cycle_number as number,
  eventTime: r.event_time as string | null,
  recordedBy: r.recorded_by as string,
  recordedAt: r.recorded_at as string,
  operationId: r.operation_id as string | null,
  createdAt: r.created_at as string,
});

// incident_closures rows are joined with their linked action ids via a
// nested select on the incident_closure_resolution_actions junction table
// (see getIncidentClosures) -- the raw row therefore carries an extra
// `incident_closure_resolution_actions: { treatment_action_id: string }[]`
// array that this mapper flattens into resolutionActionIds.
export const mapClosure = (r: Record<string, unknown>): IncidentClosureClassification => ({
  id: r.id as string,
  incidentId: r.incident_id as string,
  cycleNumber: r.cycle_number as number,
  operationId: r.operation_id as string | null,
  confirmedCause: r.confirmed_cause as IncidentClosureClassification['confirmedCause'],
  confirmedCauseOtherDetail: r.confirmed_cause_other_detail as string | null,
  treatmentOutcome: r.treatment_outcome as IncidentClosureClassification['treatmentOutcome'],
  treatmentOutcomeOtherDetail: r.treatment_outcome_other_detail as string | null,
  resolutionAttribution: r.resolution_attribution as IncidentClosureClassification['resolutionAttribution'],
  resolutionAttributionOtherDetail: r.resolution_attribution_other_detail as string | null,
  resolutionActionIds: Array.isArray(r.incident_closure_resolution_actions)
    ? (r.incident_closure_resolution_actions as Array<{ treatment_action_id: string }>).map(
        (link) => link.treatment_action_id,
      )
    : [],
  recordedBy: r.recorded_by as string,
  eventTime: r.event_time as string,
  recordedAt: r.recorded_at as string,
  createdAt: r.created_at as string,
});

export const mapIncidentEvent = (r: Record<string, unknown>): IncidentEvent => ({
  id: r.id as string,
  incidentId: r.incident_id as string,
  type: r.type as IncidentEvent['type'],
  actorId: r.actor_id as string | null,
  actorLabel: r.actor_label as string | null,
  eventTime: r.event_time as string,
  serverTime: r.server_time as string,
  field: r.field as string | null,
  oldValue: r.old_value as string | null,
  newValue: r.new_value as string | null,
  note: r.note as string | null,
  userNote: (r.user_note as string | null | undefined) ?? null,
  refId: r.ref_id as string | null,
  createdAt: r.created_at as string,
  operationId: (r.operation_id as string | null | undefined) ?? null,
});

export const mapIncidentUpdate = (r: Record<string, unknown>): IncidentUpdate => ({
  id: r.id as string,
  incidentId: r.incident_id as string,
  authorId: r.author_id as string,
  eventTime: r.event_time as string,
  serverTime: r.server_time as string,
  actionsTaken: r.actions_taken as string,
  findings: r.findings as string,
  nextSteps: r.next_steps as string,
  currentStatusText: r.current_status_text as string | null,
  updateReportedToOps: r.update_reported_to_ops as IncidentUpdate['updateReportedToOps'],
  updateReportedToOpsRecipient: r.update_reported_to_ops_recipient as string | null,
  updateReportedToComms: r.update_reported_to_comms as boolean | null,
  updateReportedToCommsRecipient: r.update_reported_to_comms_recipient as string | null,
  updateWisdomReported: r.update_wisdom_reported as boolean | null,
  userNote: (r.user_note as string | null | undefined) ?? null,
  createdAt: r.created_at as string,
});

export const mapProfile = (r: Record<string, unknown>): Profile => ({
  id: r.id as string,
  fullName: r.full_name as string,
  role: r.role as Role,
  active: r.active as boolean,
  createdAt: r.created_at as string,
  avatarUrl: (r.avatar_url as string | null | undefined) ?? null,
  operationalNotificationsEnabled: r.operational_notifications_enabled as boolean,
});

const mapOperationalNotificationPreference = (r: Record<string, unknown>): OperationalNotificationPreference => ({
  eventType: r.event_type as OperationalNotificationEventType,
  inAppEnabled: r.in_app_enabled as boolean,
  pushEnabled: r.push_enabled as boolean,
});

const mapPendingPersonnel = (r: Record<string, unknown>): PendingPersonnel => ({
  id: r.id as string,
  fullName: r.full_name as string,
  email: r.email as string,
  role: r.role as Role,
  status: r.status as PendingPersonnel['status'],
  createdBy: r.created_by as string,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
  expiresAt: r.expires_at as string | null,
  claimedBy: r.claimed_by as string | null,
  claimedAt: r.claimed_at as string | null,
  cancelledBy: r.cancelled_by as string | null,
  cancelledAt: r.cancelled_at as string | null,
  invitationStatus: r.invitation_status as PendingPersonnel['invitationStatus'],
  invitationSentAt: r.invitation_sent_at as string | null,
  invitationLastError: r.invitation_last_error as string | null,
});

export const mapSystem = (r: Record<string, unknown>): SystemRecord => ({
  id: r.id as string,
  name: r.name as string,
  archived: r.archived as boolean,
  category: r.category as SystemCategory,
  displayOrder: r.display_order as number,
  createdAt: r.created_at as string,
});

export const mapIncidentSummary = (r: Record<string, unknown>): IncidentSummary => ({
  id: r.incident_id as string,
  number: r.number as string,
  severity: r.severity as Severity,
  status: r.status as IncidentStatus,
  systemId: r.system_id as string,
  locationId: r.location_id as string,
  description: r.description as string,
});

// Same IncidentSummary shape as mapIncidentSummary above, but for a row read
// directly from the `incidents` table (primary key column `id`) rather than
// from search_incidents_for_relation's RPC result (which aliases it as
// `incident_id`) -- used by getAnalyticsTrendBucketIncidents.
const mapIncidentSummaryRow = (r: Record<string, unknown>): IncidentSummary => ({
  id: r.id as string,
  number: r.number as string,
  severity: r.severity as Severity,
  status: r.status as IncidentStatus,
  systemId: r.system_id as string,
  locationId: r.location_id as string,
  description: r.description as string,
});

export const mapSimilarIncidentSuggestion = (r: Record<string, unknown>): SimilarIncidentSuggestion => ({
  incidentId: r.incident_id as string,
  number: r.number as string,
  severity: r.severity as Severity,
  status: r.status as IncidentStatus,
  systemId: r.system_id as string,
  locationId: r.location_id as string,
  description: r.description as string,
  sameSystem: r.same_system as boolean,
  sameLocation: r.same_location as boolean,
  sameDomain: r.same_domain as boolean,
  similarityBand: r.similarity_band as SimilarIncidentSuggestion['similarityBand'],
});

// incident_relations rows are read via a view-shaped RPC (see
// getIncidentRelations) that already resolves "the other side" and its
// summary fields server-side -- this mapper never needs to know which of
// incident_a_id/incident_b_id was the canonical storage slot.
export const mapIncidentRelation = (r: Record<string, unknown>): IncidentRelation => ({
  id: r.id as string,
  relatedIncident: {
    id: r.related_incident_id as string,
    number: r.related_number as string,
    severity: r.related_severity as Severity,
    status: r.related_status as IncidentStatus,
    systemId: r.related_system_id as string,
    locationId: r.related_location_id as string,
    description: r.related_description as string,
  },
  relationType: 'related',
  createdBy: r.created_by as string,
  createdAt: r.created_at as string,
});

export const mapLocation = (r: Record<string, unknown>): LocationRecord => ({
  id: r.id as string,
  name: r.name as string,
  archived: r.archived as boolean,
  category: r.category as LocationCategory,
  displayOrder: r.display_order as number,
  createdAt: r.created_at as string,
});

export class SupabaseRepository implements Repository {
  readonly mode = 'supabase' as const;
  private client: SupabaseClient;

  /** Takes the SHARED client (src/data/supabase/client.ts) so every request
   *  carries the signed-in user's JWT -- RLS and the RPCs authorize from it. */
  constructor(client: SupabaseClient) {
    this.client = client;
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args);
    wrap(error);
    return data as T;
  }

  private async referenceDataRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args);
    wrapReferenceData(error);
    return data as T;
  }

  async listProfiles(_session: Session): Promise<Profile[]> {
    const { data, error } = await this.client.from('profiles').select('*').order('full_name');
    wrap(error);
    return (data ?? []).map(mapProfile);
  }

  async getProfile(userId: string): Promise<Profile | null> {
    const { data, error } = await this.client.from('profiles').select('*').eq('id', userId).maybeSingle();
    wrap(error);
    return data ? mapProfile(data) : null;
  }

  async listSystems(): Promise<SystemRecord[]> {
    const { data, error } = await this.client
      .from('systems')
      .select('*')
      .order('category')
      .order('display_order')
      .order('name')
      .order('id');
    wrap(error);
    return (data ?? []).map(mapSystem);
  }

  async listLocations(): Promise<LocationRecord[]> {
    const { data, error } = await this.client
      .from('locations')
      .select('*')
      .order('category')
      .order('display_order')
      .order('name')
      .order('id');
    wrap(error);
    return (data ?? []).map(mapLocation);
  }

  async createSystem(_s: Session, name: string, category: SystemCategory): Promise<SystemRecord> {
    return mapSystem(
      await this.referenceDataRpc<Record<string, unknown>>('create_system', { p_name: name, p_category: category }),
    );
  }

  async renameSystem(_s: Session, id: string, name: string): Promise<void> {
    await this.referenceDataRpc('rename_system', { p_system_id: id, p_name: name });
  }

  async setSystemArchived(_s: Session, id: string, archived: boolean): Promise<void> {
    await this.referenceDataRpc('set_system_active', { p_system_id: id, p_active: !archived });
  }

  async moveSystem(_s: Session, id: string, direction: ReferenceDataMoveDirection): Promise<void> {
    await this.referenceDataRpc('move_system', { p_system_id: id, p_direction: direction });
  }

  async deleteSystem(_s: Session, id: string): Promise<ReferenceDataDeleteOutcome> {
    return this.referenceDataRpc<ReferenceDataDeleteOutcome>('delete_system', { p_system_id: id });
  }

  async reorderSystems(_s: Session, orderedIds: string[]): Promise<void> {
    await this.referenceDataRpc('reorder_systems', { p_ids: orderedIds });
  }

  async setSystemCategory(_s: Session, id: string, category: SystemCategory): Promise<void> {
    await this.referenceDataRpc('set_system_category', { p_system_id: id, p_category: category });
  }

  async createLocation(_s: Session, name: string, category: LocationCategory): Promise<LocationRecord> {
    return mapLocation(
      await this.referenceDataRpc<Record<string, unknown>>('create_location', {
        p_name: name,
        p_category: category,
      }),
    );
  }

  async renameLocation(_s: Session, id: string, name: string): Promise<void> {
    await this.referenceDataRpc('rename_location', { p_location_id: id, p_name: name });
  }

  async setLocationArchived(_s: Session, id: string, archived: boolean): Promise<void> {
    await this.referenceDataRpc('set_location_active', { p_location_id: id, p_active: !archived });
  }

  async moveLocation(_s: Session, id: string, direction: ReferenceDataMoveDirection): Promise<void> {
    await this.referenceDataRpc('move_location', { p_location_id: id, p_direction: direction });
  }

  async deleteLocation(_s: Session, id: string): Promise<ReferenceDataDeleteOutcome> {
    return this.referenceDataRpc<ReferenceDataDeleteOutcome>('delete_location', { p_location_id: id });
  }

  async reorderLocations(_s: Session, orderedIds: string[]): Promise<void> {
    await this.referenceDataRpc('reorder_locations', { p_ids: orderedIds });
  }

  async setLocationCategory(_s: Session, id: string, category: LocationCategory): Promise<void> {
    await this.referenceDataRpc('set_location_category', { p_location_id: id, p_category: category });
  }

  async setUserRole(_s: Session, userId: string, role: Role): Promise<void> {
    await this.rpc('admin_set_user_role', { p_user_id: userId, p_role: role });
  }

  async setUserActive(_s: Session, userId: string, active: boolean): Promise<void> {
    await this.rpc('admin_set_user_active', { p_user_id: userId, p_active: active });
  }

  async renameLinkedPersonnel(_s: Session, userId: string, input: RenamePersonnelInput): Promise<void> {
    await this.rpc('admin_set_user_name', { p_user_id: userId, p_full_name: input.fullName });
  }

  async setOwnAvatarUrl(avatarUrl: string | null): Promise<void> {
    await this.rpc('set_own_avatar_url', { p_avatar_url: avatarUrl });
  }

  async getMyOperationalNotificationPreferences(_session: Session): Promise<OperationalNotificationPreference[]> {
    // Deliberately no user id parameter -- the RPC derives auth.uid() itself
    // and rejects anything but an active system_admin/professional_manager/
    // shift_supervisor.
    const rows = await this.rpc<Record<string, unknown>[]>('get_my_operational_notification_preferences', {});
    return rows.map(mapOperationalNotificationPreference);
  }

  async setMyOperationalNotificationPreference(
    _session: Session,
    eventType: OperationalNotificationEventType,
    prefs: { inAppEnabled: boolean; pushEnabled: boolean },
  ): Promise<OperationalNotificationPreference[]> {
    // Deliberately no user id parameter -- the RPC derives auth.uid() itself.
    const rows = await this.rpc<Record<string, unknown>[]>('set_my_operational_notification_preference', {
      p_event_type: eventType,
      p_in_app_enabled: prefs.inAppEnabled,
      p_push_enabled: prefs.pushEnabled,
    });
    return rows.map(mapOperationalNotificationPreference);
  }

  async savePushSubscription(_session: Session, endpoint: string, keys: { p256dh: string; auth: string }): Promise<void> {
    // No user id parameter -- save_my_push_subscription derives auth.uid()
    // itself; there is no argument a client could pass to attach a
    // subscription to anyone else.
    await this.rpc('save_my_push_subscription', {
      p_endpoint: endpoint,
      p_p256dh: keys.p256dh,
      p_auth_key: keys.auth,
    });
  }

  async deletePushSubscription(_session: Session, endpoint: string): Promise<void> {
    await this.rpc('delete_my_push_subscription', { p_endpoint: endpoint });
  }

  async deleteAllPushSubscriptions(_session: Session): Promise<void> {
    await this.rpc('delete_all_my_push_subscriptions', {});
  }

  async countPushSubscriptions(_session: Session): Promise<number> {
    return this.rpc<number>('count_my_push_subscriptions', {});
  }

  async isMyPushSubscription(_session: Session, endpoint: string): Promise<boolean> {
    return this.rpc<boolean>('is_my_push_subscription', { p_endpoint: endpoint });
  }

  async deleteUser(_s: Session, userId: string): Promise<void> {
    // The shared client (src/data/supabase/client.ts) automatically attaches
    // the current session's access token to every function invocation --
    // admin_delete_user() inside the function therefore runs as THIS
    // caller, under the exact same RPC checks as any other call. No
    // service-role or secret key is ever requested, handled, or sent here.
    const { error } = await this.client.functions.invoke('delete-user', { body: { userId } });
    if (error) throw await mapDeleteUserError(error);
  }

  // --- pre-provisioned personnel ---

  async listPendingPersonnel(_s: Session): Promise<PendingPersonnel[]> {
    // RLS restricts rows to the manager roles; writes are RPC-only.
    const { data, error } = await this.client
      .from('pending_personnel')
      .select('*')
      .order('created_at', { ascending: false });
    wrap(error);
    return (data ?? []).map(mapPendingPersonnel);
  }

  async createPendingPersonnel(_s: Session, input: PendingPersonnelInput): Promise<PendingPersonnel> {
    const data = await this.rpc<Record<string, unknown>>('create_pending_personnel', { p_input: input });
    return mapPendingPersonnel(data);
  }

  async updatePendingPersonnel(_s: Session, id: string, input: PendingPersonnelInput): Promise<PendingPersonnel> {
    const data = await this.rpc<Record<string, unknown>>('update_pending_personnel', {
      p_id: id,
      p_input: input,
    });
    return mapPendingPersonnel(data);
  }

  async renamePendingPersonnel(_s: Session, id: string, input: RenamePersonnelInput): Promise<PendingPersonnel> {
    const data = await this.rpc<Record<string, unknown>>('rename_pending_personnel', {
      p_id: id,
      p_full_name: input.fullName,
    });
    return mapPendingPersonnel(data);
  }

  async cancelPendingPersonnel(_s: Session, id: string): Promise<void> {
    await this.rpc('cancel_pending_personnel', { p_id: id });
  }

  async sendPersonnelInvitation(
    _s: Session,
    pendingPersonnelId: string,
    appOrigin: string | null,
  ): Promise<InvitationSendOutcome> {
    // The shared client (src/data/supabase/client.ts) attaches the current
    // session's access token automatically -- both RPCs inside the
    // function therefore run as THIS caller, under the exact same
    // role-ceiling check create_pending_personnel enforces. No service-role
    // or provider secret is ever requested, handled, or sent here.
    const { data, error } = await this.client.functions.invoke('send-invitation-email', {
      body: { pendingPersonnelId, origin: appOrigin },
    });
    if (error) throw await mapInvitationError(error);
    return data as InvitationSendOutcome;
  }

  async claimPendingProfile(): Promise<Profile | null> {
    // Deliberately parameterless: the RPC derives auth.uid() itself and
    // reads the verified email from auth.users -- nothing the client sends
    // can influence which entry is claimed or which role is assigned.
    const { data, error } = await this.client.rpc('claim_pending_personnel');
    if (error) {
      // "No matching entry" is the expected fail-closed outcome for an
      // unprovisioned identity -- signalled as null, not as a failure.
      if (/not_found/.test(error.message)) return null;
      wrap(error);
    }
    if (!data) return null;
    return mapProfile(data as Record<string, unknown>);
  }

  async bootstrapFirstAdmin(): Promise<Profile | null> {
    // Deliberately parameterless, like the claim RPC: identity, confirmed
    // email, Google provider and the configured bootstrap address are all
    // verified server-side. Every rejection (window closed, wrong email,
    // unverified identity) comes back as null -- fail closed.
    const { data, error } = await this.client.rpc('bootstrap_first_admin');
    wrap(error);
    if (!data) return null;
    return mapProfile(data as Record<string, unknown>);
  }

  async listPersonnel(_s: Session): Promise<PersonnelEntry[]> {
    // SECURITY DEFINER RPC: resolves linked profiles' Google emails
    // server-side (the client has no access to auth.users) and rejects
    // every caller below the manager roles.
    const rows = await this.rpc<Record<string, unknown>[]>('list_personnel', {});
    const entries: PersonnelEntry[] = (rows ?? []).map((r) => ({
      kind: r.kind as PersonnelEntry['kind'],
      id: r.id as string,
      fullName: r.full_name as string,
      email: (r.email as string | null) ?? null,
      role: r.role as Role,
      state: r.state as PersonnelEntry['state'],
      createdAt: r.created_at as string,
      avatarUrl: (r.avatar_url as string | null) ?? null,
      invitationStatus: (r.invitation_status as PersonnelEntry['invitationStatus']) ?? null,
    }));

    // list_personnel() predates the tombstone model (migration 0012) and
    // does not distinguish a deleted profile from a merely deactivated one
    // -- both come back as state 'inactive'. RLS (profiles_select) already
    // lets any active member read every profiles row, so a plain,
    // additional select for just the tombstoned ids is enough to upgrade
    // their display state to 'deleted' here -- no new RPC or migration.
    const linkedIds = entries.filter((e) => e.kind === 'linked').map((e) => e.id);
    if (linkedIds.length > 0) {
      const { data: deletedRows, error } = await this.client
        .from('profiles')
        .select('id')
        .in('id', linkedIds)
        .not('deleted_at', 'is', null);
      wrap(error);
      const deletedIds = new Set((deletedRows ?? []).map((r) => r.id as string));
      for (const e of entries) {
        if (e.kind === 'linked' && deletedIds.has(e.id)) e.state = 'deleted';
      }
    }

    return entries;
  }

  async listIncidents(
    _session: Session,
    filters: IncidentFilters = {},
    sort: IncidentSort = 'priority',
  ): Promise<Incident[]> {
    let q = this.client.from('incidents').select('*');
    // Terminal-aware on both sides: 'closed' and 'cancelled' are both
    // terminal (matches the backend's is_incident_open, migration 0016).
    // terminalOnly is the archive's scope -- both terminal outcomes, not
    // literally 'closed' -- so a cancelled incident has a real place to be
    // found after it leaves the open-incident views.
    if (filters.openOnly) q = q.not('status', 'in', '(closed,cancelled)');
    if (filters.terminalOnly) q = q.in('status', ['closed', 'cancelled']);
    if (filters.status?.length) q = q.in('status', filters.status);
    if (filters.severity?.length) q = q.in('severity', filters.severity);
    if (filters.ownerUserId) q = q.eq('owner_user_id', filters.ownerUserId);
    if (filters.systemId) q = q.eq('system_id', filters.systemId);
    if (filters.locationId) q = q.eq('location_id', filters.locationId);
    if (filters.reportedToOps) q = q.eq('reported_to_ops', filters.reportedToOps);
    if (filters.createdFrom) q = q.gte('created_at', filters.createdFrom);
    if (filters.createdTo) q = q.lte('created_at', filters.createdTo);
    if (filters.readinessAtClose?.length) q = q.in('readiness_at_close', filters.readinessAtClose);
    if (filters.followUpPending) q = q.eq('follow_up_required', true).is('follow_up_completed_at', null);
    if (filters.rootCauseText) q = q.ilike('root_cause', `%${filters.rootCauseText}%`);
    if (filters.resolutionText) q = q.ilike('resolution', `%${filters.resolutionText}%`);
    if (filters.search?.trim()) {
      const s = filters.search.trim().replaceAll('%', '');
      q = q.or(`number.ilike.%${s}%,description.ilike.%${s}%,search_text.ilike.%${s}%`);
    }
    const { data, error } = await q.limit(500);
    wrap(error);
    let rows = (data ?? []).map(mapIncident);
    switch (sort) {
      case 'priority':
        return sortByPriority(rows);
      case 'newest':
        return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      case 'oldest':
        return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      case 'next_update':
        return rows.sort((a, b) => (a.nextUpdateDue ?? '9999').localeCompare(b.nextUpdateDue ?? '9999'));
      case 'last_update':
        return rows.sort((a, b) => b.lastUpdateAt.localeCompare(a.lastUpdateAt));
    }
  }

  async countClosedIncidents(_session: Session): Promise<number> {
    // head: true asks PostgREST for the count alone -- no rows are
    // transferred and the 500-row list cap plays no part, so this stays exact
    // and cheap however large the archive grows. 'cancelled' is a separate
    // terminal outcome and is intentionally excluded.
    const { count, error } = await this.client
      .from('incidents')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'closed');
    wrap(error);
    return count ?? 0;
  }

  /**
   * Calls get_incident_analytics (migration 0036) -- the production
   * calculation authority for every ניתוחים KPI/chart/top-systems value.
   * The RPC builds its jsonb payload with the same camelCase field names
   * as IncidentAnalytics (openedInPeriod, avgCloseMinutes, buckets[].
   * bucketStart, etc.), so no snake_case->camelCase mapping step is
   * needed here, unlike mapIncident() below for the incidents table.
   */
  async getIncidentAnalytics(_session: Session, filters: AnalyticsFilters): Promise<IncidentAnalytics> {
    // Calls get_incident_analytics_v2 (migration 0051), NOT the original
    // get_incident_analytics -- a new, distinctly-named function, deployed
    // this way specifically so it never becomes an ambiguous PostgREST
    // overload of the original (see that migration's header). The original
    // 4-parameter function is left in the database, untouched, as a
    // compatibility path for any client still calling it by name -- this
    // repository method's NAME and SHAPE stay stable across that change;
    // only the RPC it targets underneath does not.
    return this.rpc<IncidentAnalytics>('get_incident_analytics_v2', {
      p_period_days: filters.periodDays,
      p_system_id: filters.systemId ?? null,
      p_location_id: filters.locationId ?? null,
      p_severities: filters.severities ?? null,
      p_domains: filters.domains ?? null,
      p_include_unclassified_domain: filters.includeUnclassifiedDomain ?? false,
      p_confirmed_causes: filters.confirmedCauses ?? null,
      p_treatment_outcomes: filters.treatmentOutcomes ?? null,
    });
  }

  async getIncidentOpenBacklog(_session: Session, filters: AnalyticsEntityFilters): Promise<IncidentOpenBacklog> {
    return this.rpc<IncidentOpenBacklog>('get_incident_open_backlog', {
      p_system_id: filters.systemId ?? null,
      p_location_id: filters.locationId ?? null,
      p_severities: filters.severities ?? null,
      p_domains: filters.domains ?? null,
      p_include_unclassified_domain: filters.includeUnclassifiedDomain ?? false,
      p_confirmed_causes: filters.confirmedCauses ?? null,
      p_treatment_outcomes: filters.treatmentOutcomes ?? null,
    });
  }

  async getIncidentClosureInsights(_session: Session, filters: AnalyticsFilters): Promise<IncidentClosureInsights> {
    return this.rpc<IncidentClosureInsights>('get_incident_closure_insights', {
      p_period_days: filters.periodDays,
      p_system_id: filters.systemId ?? null,
      p_location_id: filters.locationId ?? null,
      p_severities: filters.severities ?? null,
      p_domains: filters.domains ?? null,
      p_include_unclassified_domain: filters.includeUnclassifiedDomain ?? false,
      p_confirmed_causes: filters.confirmedCauses ?? null,
      p_treatment_outcomes: filters.treatmentOutcomes ?? null,
    });
  }

  /**
   * Direct RLS-scoped read (no RPC needed for reads -- migration 0052):
   * returns null both when the caller has never customized their view AND
   * when the caller is not personalize_analytics-eligible (the RLS policy
   * silently excludes their row either way, even if one somehow existed --
   * never a thrown error for the ineligible case, matching how the RPC's
   * own reset path treats "no row" as "use the role default").
   */
  async getAnalyticsPreferences(session: Session): Promise<AnalyticsModuleKey[] | null> {
    const { data, error } = await this.client
      .from('user_analytics_preferences')
      .select('visible_modules')
      .eq('user_id', session.userId)
      .maybeSingle();
    wrap(error);
    return (data?.visible_modules as AnalyticsModuleKey[] | undefined) ?? null;
  }

  async setAnalyticsVisibleModules(_session: Session, modules: AnalyticsModuleKey[] | null): Promise<void> {
    await this.rpc<void>('set_my_analytics_visible_modules', { p_modules: modules });
  }

  /**
   * Bounded, on-demand incidents for ONE trend-chart bucket ("לחץ לצפייה
   * בתקלות"). Deliberately NOT a dedicated RPC/migration: `incidents` and
   * `incident_closures` already carry `select using (is_active_member())`
   * RLS (migrations 0003/0046) -- the exact same gate every analytics RPC
   * enforces explicitly -- so a direct, narrowly-bounded read through this
   * client is just as safe as the existing listIncidents/getIncidentClosures
   * methods below, which already read these same tables this way.
   *
   * Semantics are pinned to match the trend chart EXACTLY, not
   * approximated:
   *  - the [rangeStart, rangeEnd) bucket boundary is computed with the same
   *    jerusalemMidnightIso/addDays helpers analyticsSummary.ts itself uses
   *    to build periodStartIso and the bucket scaffold -- not re-derived;
   *  - "opened"/"closed" are exactly discovered_at / closed_at falling in
   *    that range, the same two columns get_incident_analytics_v2 groups
   *    buckets on;
   *  - the confirmed-cause/treatment-outcome filter is applied as an
   *    unbounded-by-period incident_id EXISTS-equivalent (a first bounded
   *    query narrowing to matching ids, mirroring matchesEntityFilters'/the
   *    RPC's own `exists (select 1 from incident_closures ...)` clause) --
   *    never row-bounded to the clicked bucket itself, which would silently
   *    diverge from how every other analytics module treats this filter.
   *
   * Capped at TREND_BUCKET_DRILLDOWN_LIMIT rows per section -- a single
   * bucket's incident count is always small in practice, and this must
   * never become a path for pulling unbounded incident history into the
   * browser.
   */
  async getAnalyticsTrendBucketIncidents(
    _session: Session,
    bucketStart: string,
    bucketUnit: AnalyticsBucketUnit,
    filters: AnalyticsEntityFilters,
  ): Promise<TrendBucketIncidents> {
    const rangeStart = jerusalemMidnightIso(bucketStart);
    const rangeEnd = jerusalemMidnightIso(addDays(bucketStart, bucketUnit === 'week' ? 7 : 1));

    let qualifyingIds: string[] | null = null;
    const hasCauseOrOutcomeFilter = (filters.confirmedCauses?.length ?? 0) > 0 || (filters.treatmentOutcomes?.length ?? 0) > 0;
    if (hasCauseOrOutcomeFilter) {
      let cq = this.client.from('incident_closures').select('incident_id');
      if (filters.confirmedCauses?.length) cq = cq.in('confirmed_cause', filters.confirmedCauses);
      if (filters.treatmentOutcomes?.length) cq = cq.in('treatment_outcome', filters.treatmentOutcomes);
      const { data, error } = await cq;
      wrap(error);
      qualifyingIds = [...new Set((data ?? []).map((r) => r.incident_id as string))];
      // Short-circuit: no closure anywhere matches, so no incident ever
      // could -- skip both incidents queries below entirely.
      if (qualifyingIds.length === 0) return { opened: [], closed: [] };
    }

    const baseQuery = () => {
      let q = this.client.from('incidents').select('id, number, severity, status, system_id, location_id, description');
      if (filters.systemId) q = q.eq('system_id', filters.systemId);
      if (filters.locationId) q = q.eq('location_id', filters.locationId);
      if (filters.severities?.length) q = q.in('severity', filters.severities);
      if (filters.domains?.length && filters.includeUnclassifiedDomain) {
        q = q.or(`reported_domain.in.(${filters.domains.join(',')}),reported_domain.is.null`);
      } else if (filters.domains?.length) {
        q = q.in('reported_domain', filters.domains);
      } else if (filters.includeUnclassifiedDomain) {
        q = q.is('reported_domain', null);
      }
      if (qualifyingIds) q = q.in('id', qualifyingIds);
      return q;
    };

    const [openedRes, closedRes] = await Promise.all([
      baseQuery().gte('discovered_at', rangeStart).lt('discovered_at', rangeEnd).order('discovered_at').limit(TREND_BUCKET_DRILLDOWN_LIMIT),
      baseQuery().gte('closed_at', rangeStart).lt('closed_at', rangeEnd).order('closed_at').limit(TREND_BUCKET_DRILLDOWN_LIMIT),
    ]);
    wrap(openedRes.error);
    wrap(closedRes.error);
    return {
      opened: (openedRes.data ?? []).map(mapIncidentSummaryRow),
      closed: (closedRes.data ?? []).map(mapIncidentSummaryRow),
    };
  }

  async getIncident(_s: Session, id: string): Promise<Incident | null> {
    const { data, error } = await this.client.from('incidents').select('*').eq('id', id).maybeSingle();
    wrap(error);
    return data ? mapIncident(data) : null;
  }

  async getIncidentEvents(_s: Session, incidentId: string): Promise<IncidentEvent[]> {
    const { data, error } = await this.client
      .from('incident_events')
      .select('*')
      .eq('incident_id', incidentId)
      .order('event_time');
    wrap(error);
    return (data ?? []).map(mapIncidentEvent);
  }

  async getIncidentUpdates(_s: Session, incidentId: string): Promise<IncidentUpdate[]> {
    const { data, error } = await this.client
      .from('incident_updates')
      .select('*')
      .eq('incident_id', incidentId)
      .order('event_time');
    wrap(error);
    return (data ?? []).map(mapIncidentUpdate);
  }

  async getIncidentCauseAssessments(_s: Session, incidentId: string): Promise<IncidentCauseAssessment[]> {
    const { data, error } = await this.client
      .from('incident_cause_assessments')
      .select('*')
      .eq('incident_id', incidentId)
      .order('recorded_at');
    wrap(error);
    return (data ?? []).map(mapCauseAssessment);
  }

  async getIncidentTreatmentActions(_s: Session, incidentId: string): Promise<IncidentTreatmentAction[]> {
    const { data, error } = await this.client
      .from('incident_treatment_actions')
      .select('*')
      .eq('incident_id', incidentId)
      .order('recorded_at');
    wrap(error);
    return (data ?? []).map(mapTreatmentAction);
  }

  async getIncidentClosures(_s: Session, incidentId: string): Promise<IncidentClosureClassification[]> {
    const { data, error } = await this.client
      .from('incident_closures')
      .select('*, incident_closure_resolution_actions(treatment_action_id)')
      .eq('incident_id', incidentId)
      .order('event_time');
    wrap(error);
    return (data ?? []).map(mapClosure);
  }

  // Calls create_incident_v2 (never the legacy, still-permissive
  // create_incident): the new frontend always requires reportedDomain, so
  // it exclusively uses the always-enforcing entry point. The legacy RPC
  // remains in the database solely for any still-cached old frontend build
  // to keep working against -- see migration 0047.
  async createIncident(_s: Session, input: CreateIncidentInput): Promise<Incident> {
    const data = await this.rpc<Record<string, unknown>>('create_incident_v2', { p_input: input });
    return mapIncident(data);
  }

  async acknowledgeIncident(_s: Session, incidentId: string, expectedVersion: number): Promise<Incident> {
    const data = await this.rpc<Record<string, unknown>>('acknowledge_incident', {
      p_incident_id: incidentId,
      p_expected_version: expectedVersion,
    });
    return mapIncident(data);
  }

  async updateIncident(_s: Session, incidentId: string, input: UpdateIncidentInput): Promise<Incident> {
    const data = await this.rpc<Record<string, unknown>>('update_incident', {
      p_incident_id: incidentId,
      p_input: input,
    });
    return mapIncident(data);
  }

  async technicianUpdate(_s: Session, incidentId: string, input: TechnicianUpdateInput): Promise<Incident> {
    const data = await this.rpc<Record<string, unknown>>('technician_update_incident', {
      p_incident_id: incidentId,
      p_input: input,
    });
    return mapIncident(data);
  }

  async assignIncident(_s: Session, incidentId: string, input: AssignIncidentInput): Promise<Incident> {
    const data = await this.rpc<Record<string, unknown>>('assign_incident', {
      p_incident_id: incidentId,
      p_input: input,
    });
    return mapIncident(data);
  }

  // Calls close_incident_v2, for the same reason createIncident above
  // calls create_incident_v2 -- the new frontend always collects the full
  // closure classification on a genuine close, so it exclusively uses the
  // always-enforcing entry point.
  async closeIncident(_s: Session, incidentId: string, input: CloseIncidentInput): Promise<Incident> {
    const data = await this.rpc<Record<string, unknown>>('close_incident_v2', {
      p_incident_id: incidentId,
      p_input: input,
    });
    return mapIncident(data);
  }

  async cancelIncident(_s: Session, incidentId: string, input: CancelIncidentInput): Promise<Incident> {
    const data = await this.rpc<Record<string, unknown>>('cancel_incident', {
      p_incident_id: incidentId,
      p_input: input,
    });
    return mapIncident(data);
  }

  async reopenIncident(_s: Session, incidentId: string, input: ReopenIncidentInput): Promise<Incident> {
    const data = await this.rpc<Record<string, unknown>>('reopen_incident', {
      p_incident_id: incidentId,
      p_input: input,
    });
    return mapIncident(data);
  }

  async addCorrection(_s: Session, incidentId: string, input: CorrectionInput): Promise<void> {
    await this.rpc('add_incident_correction', { p_incident_id: incidentId, p_input: input });
  }

  async completeFollowUp(_s: Session, incidentId: string, note: string): Promise<Incident> {
    const data = await this.rpc<Record<string, unknown>>('complete_follow_up', {
      p_incident_id: incidentId,
      p_note: note,
    });
    return mapIncident(data);
  }

  async permanentlyDeleteIncident(_s: Session, incidentId: string): Promise<void> {
    await this.rpc<null>('admin_purge_incident', { p_incident_id: incidentId });
  }

  async suggestSimilarIncidents(
    _s: Session,
    query: { systemId: string; locationId: string | null; reportedDomain: IncidentDomain | null; description: string },
  ): Promise<SimilarIncidentSuggestion[]> {
    const { data, error } = await this.client.rpc('suggest_related_incidents', {
      p_system_id: query.systemId,
      p_description: query.description,
      p_location_id: query.locationId,
      p_reported_domain: query.reportedDomain,
    });
    wrap(error);
    return (data ?? []).map(mapSimilarIncidentSuggestion);
  }

  async getIncidentRelations(_s: Session, incidentId: string): Promise<IncidentRelation[]> {
    const { data, error } = await this.client.rpc('get_incident_relations', { p_incident_id: incidentId });
    wrap(error);
    return (data ?? []).map(mapIncidentRelation);
  }

  async linkIncidentOnCreation(_s: Session, newIncidentId: string, relatedIncidentId: string): Promise<void> {
    await this.rpc('link_incident_on_creation', {
      p_new_incident_id: newIncidentId,
      p_related_incident_id: relatedIncidentId,
    });
  }

  async manageIncidentRelation(
    _s: Session,
    incidentId: string,
    relatedIncidentId: string,
    action: 'link' | 'unlink',
  ): Promise<void> {
    await this.rpc('manage_incident_relation', {
      p_incident_id: incidentId,
      p_related_incident_id: relatedIncidentId,
      p_action: action,
    });
  }

  async searchIncidentsForRelation(_s: Session, query: string, excludeIncidentId: string): Promise<IncidentSummary[]> {
    const { data, error } = await this.client.rpc('search_incidents_for_relation', {
      p_query: query,
      p_exclude_incident_id: excludeIncidentId,
    });
    wrap(error);
    return (data ?? []).map(mapIncidentSummary);
  }

  // Bounded: the bell is a compact notification center, not an audit log --
  // this is the hard cap on how much history a client ever loads for it.
  static readonly NOTIFICATIONS_LIMIT = 50;

  async listNotifications(session: Session): Promise<AppNotification[]> {
    const { data, error } = await this.client
      .from('notifications')
      .select('*')
      .eq('user_id', session.userId)
      // 'update_overdue': the next-update-ETA concept was removed from the
      // active product -- no new row of this type is ever written, and
      // migration 0044 deletes any historical row outright, but this filter
      // stays as defense in depth for a database migrated from an older
      // snapshot. Excluded from the active list (and therefore the unread
      // badge, which derives its count from this same result).
      .neq('type', 'update_overdue')
      // Cleared (נקה הכל) rows are preserved server-side, never deleted, but
      // excluded from every active list/filter tab -- see clearNotifications
      // and migration 0048's partial index on this exact predicate.
      .is('dismissed_at', null)
      .order('created_at', { ascending: false })
      .limit(SupabaseRepository.NOTIFICATIONS_LIMIT);
    wrap(error);
    return (data ?? []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      type: r.type,
      category: r.category,
      incidentId: r.incident_id,
      handoverId: r.handover_id,
      text: r.text,
      read: r.read,
      createdAt: r.created_at,
    }));
  }

  async markNotificationRead(_s: Session, id: string): Promise<void> {
    wrap((await this.client.from('notifications').update({ read: true }).eq('id', id)).error);
  }

  async markAllNotificationsRead(session: Session): Promise<void> {
    wrap(
      (await this.client.from('notifications').update({ read: true }).eq('user_id', session.userId)).error,
    );
  }

  async clearNotifications(_session: Session): Promise<void> {
    // Deliberately no user id parameter -- the RPC derives auth.uid() itself
    // and scopes the bulk dismissal to exactly the caller's own rows, so
    // there is no argument through which a client could dismiss another
    // user's notifications.
    await this.rpc('clear_my_notifications', {});
  }

  async listAuditLogs(
    _s: Session,
    filters: AuditFilters = {},
    page: number = 1,
    pageSize: number = 25,
  ): Promise<AuditLogPage> {
    // list_audit_events is the bounded, paginated read path (migration
    // 0042): it clamps p_limit server-side regardless of what is passed
    // here, applies its own role check independent of RLS, and returns a
    // windowed total_count alongside each page -- never a raw unrestricted
    // table select. page is 1-based; converted to a 0-based offset here.
    const clampedSize = Math.min(Math.max(pageSize, 1), 100);
    const offset = Math.max(page - 1, 0) * clampedSize;
    const rows = await this.rpc<Array<Record<string, unknown>>>('list_audit_events', {
      p_limit: clampedSize,
      p_offset: offset,
      p_from: filters.from ?? null,
      p_to: filters.to ?? null,
      p_actor_id: filters.actorId ?? null,
      p_entity_type: filters.entityType ?? null,
      p_action: filters.action ?? null,
      p_search: filters.search ?? null,
    });
    const items: AuditLog[] = (rows ?? []).map((r) => ({
      id: r.id as string,
      actorId: r.actor_id as string | null,
      actorDisplayName: r.actor_display_name as string | null,
      actorEmail: r.actor_email as string | null,
      action: r.action as string,
      entityType: r.entity_type as string,
      entityId: r.entity_id as string,
      entityLabel: r.entity_label as string | null,
      summary: r.summary as string | null,
      incidentNumber: r.incident_number as string | null,
      before: r.before_data ? JSON.stringify(r.before_data) : null,
      after: r.after_data ? JSON.stringify(r.after_data) : null,
      metadata: r.metadata ? JSON.stringify(r.metadata) : null,
      correlationId: null,
      createdAt: r.created_at as string,
    }));
    const total = rows && rows.length > 0 ? Number(rows[0].total_count) : 0;
    return { items, total };
  }

  async recordExport(_s: Session, info: ExportAuditInfo): Promise<void> {
    await this.rpc('record_export', {
      p_export_type: info.exportType,
      p_filters: info.filtersDescription,
    });
  }

  async canExport(_s: Session): Promise<boolean> {
    const data = await this.rpc<boolean>('can_export', {});
    return data === true;
  }
}
