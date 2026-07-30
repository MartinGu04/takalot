// SupabaseRepository: production-ready data layer wired to the SQL schema in
// /supabase/migrations. Authorization is enforced by RLS policies and SECURITY
// DEFINER RPCs in the database — not by this client code.
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AppNotification,
  AuditLog,
  Handover,
  HandoverAddendum,
  HandoverItem,
  Incident,
  IncidentEvent,
  IncidentUpdate,
  LocationRecord,
  PendingPersonnel,
  PersonnelEntry,
  Profile,
  Role,
  SystemRecord,
} from '../../domain/types';
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
} from '../../domain/schemas';
import { AppError } from '../repository';
import type {
  AuditFilters,
  ExportAuditInfo,
  IncidentFilters,
  IncidentSort,
  ReferenceDataDeleteOutcome,
  ReferenceDataMoveDirection,
  Repository,
  Session,
} from '../repository';
import { isOverdue, sortByPriority } from '../../domain/overdue';

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

// snake_case rows → camelCase domain objects
const mapIncident = (r: Record<string, unknown>): Incident => ({
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
});

const mapSystem = (r: Record<string, unknown>): SystemRecord => ({
  id: r.id as string,
  name: r.name as string,
  archived: r.archived as boolean,
  displayOrder: r.display_order as number,
  createdAt: r.created_at as string,
});

const mapLocation = (r: Record<string, unknown>): LocationRecord => ({
  id: r.id as string,
  name: r.name as string,
  archived: r.archived as boolean,
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
    return (data ?? []).map((r) => ({
      id: r.id,
      fullName: r.full_name,
      role: r.role,
      active: r.active,
      createdAt: r.created_at,
    }));
  }

  async getProfile(userId: string): Promise<Profile | null> {
    const { data, error } = await this.client.from('profiles').select('*').eq('id', userId).maybeSingle();
    wrap(error);
    return data
      ? { id: data.id, fullName: data.full_name, role: data.role, active: data.active, createdAt: data.created_at }
      : null;
  }

  async listSystems(): Promise<SystemRecord[]> {
    const { data, error } = await this.client
      .from('systems')
      .select('*')
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
      .order('display_order')
      .order('name')
      .order('id');
    wrap(error);
    return (data ?? []).map(mapLocation);
  }

  async createSystem(_s: Session, name: string): Promise<SystemRecord> {
    return mapSystem(await this.referenceDataRpc<Record<string, unknown>>('create_system', { p_name: name }));
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

  async createLocation(_s: Session, name: string): Promise<LocationRecord> {
    return mapLocation(await this.referenceDataRpc<Record<string, unknown>>('create_location', { p_name: name }));
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

  async setUserRole(_s: Session, userId: string, role: Role): Promise<void> {
    await this.rpc('admin_set_user_role', { p_user_id: userId, p_role: role });
  }

  async setUserActive(_s: Session, userId: string, active: boolean): Promise<void> {
    await this.rpc('admin_set_user_active', { p_user_id: userId, p_active: active });
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

  async cancelPendingPersonnel(_s: Session, id: string): Promise<void> {
    await this.rpc('cancel_pending_personnel', { p_id: id });
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
    const r = data as Record<string, unknown>;
    return {
      id: r.id as string,
      fullName: r.full_name as string,
      role: r.role as Role,
      active: r.active as boolean,
      createdAt: r.created_at as string,
    };
  }

  async bootstrapFirstAdmin(): Promise<Profile | null> {
    // Deliberately parameterless, like the claim RPC: identity, confirmed
    // email, Google provider and the configured bootstrap address are all
    // verified server-side. Every rejection (window closed, wrong email,
    // unverified identity) comes back as null -- fail closed.
    const { data, error } = await this.client.rpc('bootstrap_first_admin');
    wrap(error);
    if (!data) return null;
    const r = data as Record<string, unknown>;
    return {
      id: r.id as string,
      fullName: r.full_name as string,
      role: r.role as Role,
      active: r.active as boolean,
      createdAt: r.created_at as string,
    };
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
    const now = new Date();
    if (filters.overdueOnly) rows = rows.filter((i) => isOverdue(i, now));
    switch (sort) {
      case 'priority':
        return sortByPriority(rows, now);
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
    return (data ?? []).map((r) => ({
      id: r.id,
      incidentId: r.incident_id,
      type: r.type,
      actorId: r.actor_id,
      actorLabel: r.actor_label,
      eventTime: r.event_time,
      serverTime: r.server_time,
      field: r.field,
      oldValue: r.old_value,
      newValue: r.new_value,
      note: r.note,
      refId: r.ref_id,
      createdAt: r.created_at,
    }));
  }

  async getIncidentUpdates(_s: Session, incidentId: string): Promise<IncidentUpdate[]> {
    const { data, error } = await this.client
      .from('incident_updates')
      .select('*')
      .eq('incident_id', incidentId)
      .order('event_time');
    wrap(error);
    return (data ?? []).map((r) => ({
      id: r.id,
      incidentId: r.incident_id,
      authorId: r.author_id,
      eventTime: r.event_time,
      serverTime: r.server_time,
      actionsTaken: r.actions_taken,
      findings: r.findings,
      nextSteps: r.next_steps,
      createdAt: r.created_at,
    }));
  }

  async createIncident(_s: Session, input: CreateIncidentInput): Promise<Incident> {
    const data = await this.rpc<Record<string, unknown>>('create_incident', { p_input: input });
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

  async closeIncident(_s: Session, incidentId: string, input: CloseIncidentInput): Promise<Incident> {
    const data = await this.rpc<Record<string, unknown>>('close_incident', {
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

  async listHandovers(_s: Session): Promise<Handover[]> {
    const { data, error } = await this.client
      .from('handovers')
      .select('*')
      .order('created_at', { ascending: false });
    wrap(error);
    return (data ?? []).map((r) => ({
      id: r.id,
      createdBy: r.created_by,
      createdAt: r.created_at,
      toUserId: r.to_user_id,
      generalNote: r.general_note,
      status: r.status,
      acceptedAt: r.accepted_at,
      acceptedBy: r.accepted_by,
    }));
  }

  async getHandover(_s: Session, id: string) {
    const { data, error } = await this.client.from('handovers').select('*').eq('id', id).maybeSingle();
    wrap(error);
    if (!data) return null;
    const [items, addenda] = await Promise.all([
      this.client.from('handover_items').select('*').eq('handover_id', id),
      this.client.from('handover_addenda').select('*').eq('handover_id', id).order('created_at'),
    ]);
    wrap(items.error);
    wrap(addenda.error);
    return {
      handover: {
        id: data.id,
        createdBy: data.created_by,
        createdAt: data.created_at,
        toUserId: data.to_user_id,
        generalNote: data.general_note,
        status: data.status,
        acceptedAt: data.accepted_at,
        acceptedBy: data.accepted_by,
      } as Handover,
      items: (items.data ?? []).map(
        (r): HandoverItem => ({
          id: r.id,
          handoverId: r.handover_id,
          incidentId: r.incident_id,
          note: r.note,
          snapshotNumber: r.snapshot_number,
          snapshotStatus: r.snapshot_status,
          snapshotSeverity: r.snapshot_severity,
          snapshotOwnerLabel: r.snapshot_owner_label,
          snapshotSystemName: r.snapshot_system_name,
          snapshotLocationName: r.snapshot_location_name,
          snapshotImpact: r.snapshot_impact,
          snapshotLastAction: r.snapshot_last_action,
          snapshotNextSteps: r.snapshot_next_steps,
          snapshotNextUpdateDue: r.snapshot_next_update_due,
        }),
      ),
      addenda: (addenda.data ?? []).map(
        (r): HandoverAddendum => ({
          id: r.id,
          handoverId: r.handover_id,
          authorId: r.author_id,
          text: r.text,
          createdAt: r.created_at,
        }),
      ),
    };
  }

  async createHandover(_s: Session, input: CreateHandoverInput): Promise<Handover> {
    const data = await this.rpc<Record<string, unknown>>('create_handover', { p_input: input });
    return {
      id: data.id as string,
      createdBy: data.created_by as string,
      createdAt: data.created_at as string,
      toUserId: data.to_user_id as string,
      generalNote: data.general_note as string,
      status: data.status as Handover['status'],
      acceptedAt: data.accepted_at as string | null,
      acceptedBy: data.accepted_by as string | null,
    };
  }

  async acceptHandover(_s: Session, handoverId: string): Promise<Handover> {
    const data = await this.rpc<Record<string, unknown>>('accept_handover', { p_handover_id: handoverId });
    return {
      id: data.id as string,
      createdBy: data.created_by as string,
      createdAt: data.created_at as string,
      toUserId: data.to_user_id as string,
      generalNote: data.general_note as string,
      status: data.status as Handover['status'],
      acceptedAt: data.accepted_at as string | null,
      acceptedBy: data.accepted_by as string | null,
    };
  }

  async addHandoverAddendum(_s: Session, handoverId: string, text: string): Promise<void> {
    await this.rpc('add_handover_addendum', { p_handover_id: handoverId, p_text: text });
  }

  async listNotifications(session: Session): Promise<AppNotification[]> {
    const { data, error } = await this.client
      .from('notifications')
      .select('*')
      .eq('user_id', session.userId)
      .order('created_at', { ascending: false });
    wrap(error);
    return (data ?? []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      type: r.type,
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

  async listAuditLogs(_s: Session, filters: AuditFilters = {}): Promise<AuditLog[]> {
    let q = this.client.from('audit_logs').select('*');
    if (filters.actorId) q = q.eq('actor_id', filters.actorId);
    if (filters.action) q = q.ilike('action', `%${filters.action}%`);
    if (filters.incidentNumber) q = q.ilike('incident_number', `%${filters.incidentNumber}%`);
    if (filters.from) q = q.gte('created_at', filters.from);
    if (filters.to) q = q.lte('created_at', filters.to);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(500);
    wrap(error);
    return (data ?? []).map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      incidentNumber: r.incident_number,
      before: r.before_data ? JSON.stringify(r.before_data) : null,
      after: r.after_data ? JSON.stringify(r.after_data) : null,
      correlationId: r.correlation_id,
      createdAt: r.created_at,
    }));
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
