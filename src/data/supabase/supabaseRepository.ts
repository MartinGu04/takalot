// SupabaseRepository: production-ready data layer wired to the SQL schema in
// /supabase/migrations. Authorization is enforced by RLS policies and SECURITY
// DEFINER RPCs in the database — not by this client code.
//
// NOTE: this implementation is ready for connection but has NOT been executed
// against a live Supabase project in this build (no credentials available).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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
  Profile,
  Role,
  SystemRecord,
} from '../../domain/types';
import type {
  AssignIncidentInput,
  CloseIncidentInput,
  CorrectionInput,
  CreateHandoverInput,
  CreateIncidentInput,
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
  Repository,
  Session,
} from '../repository';
import { isOverdue, sortByPriority } from '../../domain/overdue';

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
  throw new AppError('NETWORK', `שגיאת תקשורת מול השרת: ${error.message}`);
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
});

export class SupabaseRepository implements Repository {
  readonly mode = 'supabase' as const;
  private client: SupabaseClient;

  constructor(url: string, anonKey: string) {
    this.client = createClient(url, anonKey);
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args);
    wrap(error);
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
    const { data, error } = await this.client.from('systems').select('*').order('name');
    wrap(error);
    return (data ?? []).map((r) => ({ id: r.id, name: r.name, archived: r.archived, createdAt: r.created_at }));
  }

  async listLocations(): Promise<LocationRecord[]> {
    const { data, error } = await this.client.from('locations').select('*').order('name');
    wrap(error);
    return (data ?? []).map((r) => ({ id: r.id, name: r.name, archived: r.archived, createdAt: r.created_at }));
  }

  async createSystem(_s: Session, name: string): Promise<SystemRecord> {
    const { data, error } = await this.client.from('systems').insert({ name }).select().single();
    wrap(error);
    return { id: data.id, name: data.name, archived: data.archived, createdAt: data.created_at };
  }

  async renameSystem(_s: Session, id: string, name: string): Promise<void> {
    wrap((await this.client.from('systems').update({ name }).eq('id', id)).error);
  }

  async setSystemArchived(_s: Session, id: string, archived: boolean): Promise<void> {
    wrap((await this.client.from('systems').update({ archived }).eq('id', id)).error);
  }

  async createLocation(_s: Session, name: string): Promise<LocationRecord> {
    const { data, error } = await this.client.from('locations').insert({ name }).select().single();
    wrap(error);
    return { id: data.id, name: data.name, archived: data.archived, createdAt: data.created_at };
  }

  async renameLocation(_s: Session, id: string, name: string): Promise<void> {
    wrap((await this.client.from('locations').update({ name }).eq('id', id)).error);
  }

  async setLocationArchived(_s: Session, id: string, archived: boolean): Promise<void> {
    wrap((await this.client.from('locations').update({ archived }).eq('id', id)).error);
  }

  async createUser(_s: Session, fullName: string, role: Role): Promise<Profile> {
    // Placeholder profile record; real auth invitation is a separate admin action.
    const data = await this.rpc<Record<string, unknown>>('admin_create_placeholder_profile', {
      p_full_name: fullName,
      p_role: role,
    });
    return {
      id: data.id as string,
      fullName: data.full_name as string,
      role: data.role as Role,
      active: data.active as boolean,
      createdAt: data.created_at as string,
    };
  }

  async setUserRole(_s: Session, userId: string, role: Role): Promise<void> {
    await this.rpc('admin_set_user_role', { p_user_id: userId, p_role: role });
  }

  async setUserActive(_s: Session, userId: string, active: boolean): Promise<void> {
    await this.rpc('admin_set_user_active', { p_user_id: userId, p_active: active });
  }

  async listIncidents(
    _session: Session,
    filters: IncidentFilters = {},
    sort: IncidentSort = 'priority',
  ): Promise<Incident[]> {
    let q = this.client.from('incidents').select('*');
    if (filters.openOnly) q = q.neq('status', 'closed');
    if (filters.closedOnly) q = q.eq('status', 'closed');
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
