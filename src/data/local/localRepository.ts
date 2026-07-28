// LocalDemoRepository: the demo-mode backend. It enforces permissions, status
// transitions, atomic numbering, and optimistic concurrency exactly as the real
// backend (Supabase RLS + RPCs) would — it is NOT a UI-side convenience layer.
// It is still local demo data and must never be presented as a secured backend.
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
  EventType,
} from '../../domain/types';
import { isOpen } from '../../domain/types';
import { reportedToOpsLabels } from '../../domain/labels';
import { hasCapability, canTechnicianUpdate, allowedAssignRoles, allowedManageRoles, type Capability } from '../../domain/permissions';
import { canTransition, transitionError } from '../../domain/transitions';
import { isOverdue, sortByPriority } from '../../domain/overdue';
import {
  assignIncidentSchema,
  cancelIncidentSchema,
  closeIncidentSchema,
  correctionSchema,
  createHandoverSchema,
  createIncidentSchema,
  pendingPersonnelInputSchema,
  reopenIncidentSchema,
  technicianUpdateSchema,
  updateIncidentSchema,
  type AssignIncidentInput,
  type CancelIncidentInput,
  type CloseIncidentInput,
  type CorrectionInput,
  type CreateHandoverInput,
  type CreateIncidentInput,
  type PendingPersonnelInput,
  type ReopenIncidentInput,
  type TechnicianUpdateInput,
  type UpdateIncidentInput,
} from '../../domain/schemas';
import type { ZodTypeAny, z } from 'zod';
import { jerusalemYear } from '../../lib/time';
import { newId } from '../../lib/id';
import { AppError } from '../repository';
import type {
  AuditFilters,
  ExportAuditInfo,
  IncidentFilters,
  IncidentSort,
  Repository,
  Session,
} from '../repository';
import type { DemoDatabase, DemoStorage } from './storage';
import { emptyDatabase } from './storage';
import { buildSeed } from './seed';

const CONFLICT_MSG =
  'התקלה עודכנה על ידי משתמש אחר מאז שנפתח המסך. יש לרענן את הדף ולבדוק את הנתונים לפני שמירה חוזרת.';

function parseOrThrow<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const msg = result.error.issues[0]?.message ?? 'קלט לא תקין';
    throw new AppError('VALIDATION', msg);
  }
  return result.data;
}

export interface LocalRepositoryOptions {
  now?: () => Date;
  autoSeed?: boolean;
}

export class LocalDemoRepository implements Repository {
  readonly mode = 'demo' as const;
  private storage: DemoStorage;
  private db: DemoDatabase;
  private now: () => Date;

  constructor(storage: DemoStorage, options: LocalRepositoryOptions = {}) {
    this.storage = storage;
    this.now = options.now ?? (() => new Date());
    const loaded = storage.load();
    if (loaded && loaded.seededAt) {
      this.db = loaded;
    } else if (options.autoSeed !== false) {
      this.db = buildSeed(this.now());
      this.persist();
    } else {
      this.db = emptyDatabase();
      this.db.seededAt = this.now().toISOString();
      this.persist();
    }
  }

  resetDemoData(): void {
    this.db = buildSeed(this.now());
    this.persist();
  }

  setPolicy(policy: Partial<DemoDatabase['policy']>): void {
    this.db.policy = { ...this.db.policy, ...policy };
    this.persist();
  }

  private persist(): void {
    this.storage.save(this.db);
  }

  // --- session & permission helpers ---

  private requireSession(session: Session): Profile {
    const profile = this.db.profiles.find((p) => p.id === session.userId);
    if (!profile) {
      throw new AppError('SESSION_EXPIRED', 'פג תוקף ההתחברות. יש להתחבר מחדש.');
    }
    if (!profile.active) {
      throw new AppError('FORBIDDEN', 'חשבון המשתמש אינו פעיל. יש לפנות למנהל המערכת.');
    }
    return profile;
  }

  private requireCap(session: Session, cap: Capability): Profile {
    const profile = this.requireSession(session);
    if (!hasCapability(profile.role, cap, this.db.policy, profile.id)) {
      throw new AppError('FORBIDDEN', 'אין לך הרשאה לבצע פעולה זו.');
    }
    return profile;
  }

  private audit(
    actorId: string | null,
    action: string,
    entityType: string,
    entityId: string,
    extra: Partial<AuditLog> = {},
  ): void {
    this.db.auditLogs.push({
      id: newId(),
      actorId,
      action,
      entityType,
      entityId,
      incidentNumber: null,
      before: null,
      after: null,
      correlationId: newId().slice(0, 8),
      createdAt: this.now().toISOString(),
      ...extra,
    });
  }

  private addEvent(
    incidentId: string,
    type: EventType,
    actorId: string | null,
    extra: Partial<IncidentEvent> = {},
  ): IncidentEvent {
    const ts = this.now().toISOString();
    const event: IncidentEvent = {
      id: newId(),
      incidentId,
      type,
      actorId,
      actorLabel: null,
      eventTime: ts,
      serverTime: ts,
      field: null,
      oldValue: null,
      newValue: null,
      note: null,
      refId: null,
      createdAt: ts,
      ...extra,
    };
    this.db.incidentEvents.push(event);
    return event;
  }

  private notify(
    userId: string,
    type: AppNotification['type'],
    text: string,
    opts: { incidentId?: string; handoverId?: string; dedupeKey?: string } = {},
  ): void {
    if (opts.dedupeKey && this.db.notifications.some((n) => n.dedupeKey === opts.dedupeKey)) {
      return;
    }
    this.db.notifications.push({
      id: newId(),
      userId,
      type,
      incidentId: opts.incidentId ?? null,
      handoverId: opts.handoverId ?? null,
      text,
      read: false,
      createdAt: this.now().toISOString(),
      dedupeKey: opts.dedupeKey,
    });
  }

  private ownerLabel(userId: string | null, externalName: string | null): string {
    if (userId) return this.db.profiles.find((p) => p.id === userId)?.fullName ?? 'משתמש לא ידוע';
    return externalName ? `${externalName} (גורם חיצוני)` : 'ללא גורם מטפל';
  }

  private getIncidentOrThrow(id: string): Incident {
    const incident = this.db.incidents.find((i) => i.id === id);
    if (!incident) throw new AppError('NOT_FOUND', 'התקלה המבוקשת לא נמצאה.');
    return incident;
  }

  private checkVersion(incident: Incident, expectedVersion: number): void {
    if (incident.version !== expectedVersion) {
      throw new AppError('CONFLICT', CONFLICT_MSG);
    }
  }

  private validateOwner(ownerUserId: string | null): void {
    if (!ownerUserId) return;
    const owner = this.db.profiles.find((p) => p.id === ownerUserId);
    if (!owner) throw new AppError('VALIDATION', 'הגורם המטפל שנבחר אינו קיים.');
    if (!owner.active) {
      throw new AppError('VALIDATION', 'הגורם המטפל שנבחר אינו פעיל. יש לבחור משתמש פעיל אחר.');
    }
  }

  /** Allocate the next YYYY-NNN number atomically (single mutation of the sequence map). */
  private allocateNumber(): string {
    const year = String(jerusalemYear(this.now()));
    const next = (this.db.sequences[year] ?? 0) + 1;
    this.db.sequences[year] = next;
    return `${year}-${String(next).padStart(3, '0')}`;
  }

  // --- profiles ---

  async listProfiles(session: Session): Promise<Profile[]> {
    this.requireSession(session);
    return [...this.db.profiles].sort((a, b) => a.fullName.localeCompare(b.fullName, 'he'));
  }

  async getProfile(userId: string): Promise<Profile | null> {
    return this.db.profiles.find((p) => p.id === userId) ?? null;
  }

  // --- configuration ---

  async listSystems(): Promise<SystemRecord[]> {
    return [...this.db.systems].sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }

  async listLocations(): Promise<LocationRecord[]> {
    return [...this.db.locations].sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }

  private requireName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) throw new AppError('VALIDATION', 'יש להזין שם.');
    if (trimmed.length > 120) throw new AppError('VALIDATION', 'שם ארוך מדי (עד 120 תווים).');
    return trimmed;
  }

  async createSystem(session: Session, name: string): Promise<SystemRecord> {
    const actor = this.requireCap(session, 'manage_config');
    const record: SystemRecord = {
      id: newId(),
      name: this.requireName(name),
      archived: false,
      createdAt: this.now().toISOString(),
    };
    this.db.systems.push(record);
    this.audit(actor.id, 'system_created', 'system', record.id, { after: JSON.stringify(record) });
    this.persist();
    return record;
  }

  async renameSystem(session: Session, id: string, name: string): Promise<void> {
    const actor = this.requireCap(session, 'manage_config');
    const record = this.db.systems.find((s) => s.id === id);
    if (!record) throw new AppError('NOT_FOUND', 'המערכת לא נמצאה.');
    const before = record.name;
    record.name = this.requireName(name);
    this.audit(actor.id, 'system_renamed', 'system', id, {
      before: JSON.stringify({ name: before }),
      after: JSON.stringify({ name: record.name }),
    });
    this.persist();
  }

  async setSystemArchived(session: Session, id: string, archived: boolean): Promise<void> {
    const actor = this.requireCap(session, 'manage_config');
    const record = this.db.systems.find((s) => s.id === id);
    if (!record) throw new AppError('NOT_FOUND', 'המערכת לא נמצאה.');
    record.archived = archived;
    this.audit(actor.id, archived ? 'system_archived' : 'system_restored', 'system', id);
    this.persist();
  }

  async createLocation(session: Session, name: string): Promise<LocationRecord> {
    const actor = this.requireCap(session, 'manage_config');
    const record: LocationRecord = {
      id: newId(),
      name: this.requireName(name),
      archived: false,
      createdAt: this.now().toISOString(),
    };
    this.db.locations.push(record);
    this.audit(actor.id, 'location_created', 'location', record.id, { after: JSON.stringify(record) });
    this.persist();
    return record;
  }

  async renameLocation(session: Session, id: string, name: string): Promise<void> {
    const actor = this.requireCap(session, 'manage_config');
    const record = this.db.locations.find((l) => l.id === id);
    if (!record) throw new AppError('NOT_FOUND', 'המיקום לא נמצא.');
    const before = record.name;
    record.name = this.requireName(name);
    this.audit(actor.id, 'location_renamed', 'location', id, {
      before: JSON.stringify({ name: before }),
      after: JSON.stringify({ name: record.name }),
    });
    this.persist();
  }

  async setLocationArchived(session: Session, id: string, archived: boolean): Promise<void> {
    const actor = this.requireCap(session, 'manage_config');
    const record = this.db.locations.find((l) => l.id === id);
    if (!record) throw new AppError('NOT_FOUND', 'המיקום לא נמצא.');
    record.archived = archived;
    this.audit(actor.id, archived ? 'location_archived' : 'location_restored', 'location', id);
    this.persist();
  }

  // --- linked-personnel management ---
  // Mirrors 0010's rules exactly (allowedManageRoles / role_ceiling_allows_manage
  // -- a strict hierarchy, deliberately separate from allowedAssignRoles /
  // role_ceiling_allows_assign used by pending-personnel below -- plus
  // unconditional self-protection and last-active-admin protection). See
  // requirePersonnelManager below, shared with the pending-personnel RPCs.

  // Guards the last-active-admin invariant. In the real backend this is a
  // race-safety backstop (see 0010's header) against two CONCURRENT
  // requests each removing a different admin at once; this single-
  // threaded demo repository has no such race, so here it is simply a
  // direct, always-correct count.
  private countActiveAdmins(): number {
    return this.db.profiles.filter((p) => p.role === 'system_admin' && p.active).length;
  }

  async setUserRole(session: Session, userId: string, role: Role): Promise<void> {
    const actor = this.requirePersonnelManager(session);
    if (userId === actor.id) {
      throw new AppError('FORBIDDEN', 'לא ניתן לשנות את התפקיד של עצמך.');
    }
    const profile = this.db.profiles.find((p) => p.id === userId);
    if (!profile) throw new AppError('NOT_FOUND', 'המשתמש לא נמצא.');
    const ceiling = allowedManageRoles(actor.role);
    if (!ceiling.includes(profile.role) || !ceiling.includes(role)) {
      throw new AppError('FORBIDDEN', 'אין הרשאה לנהל משתמש בתפקיד זה.');
    }
    // Mirrors migration 0012: a tombstoned profile's role is permanent
    // history, not an editable field.
    if (profile.deletedAt) {
      throw new AppError('VALIDATION', 'לא ניתן לשנות תפקיד למשתמש שנמחק.');
    }
    if (profile.role === 'system_admin' && profile.active && role !== 'system_admin' && this.countActiveAdmins() <= 1) {
      throw new AppError('VALIDATION', 'לא ניתן להוריד בדרגה את מנהל המערכת הפעיל האחרון.');
    }
    const before = profile.role;
    profile.role = role;
    this.audit(actor.id, 'user_role_changed', 'profile', userId, {
      before: JSON.stringify({ role: before }),
      after: JSON.stringify({ role }),
    });
    this.persist();
  }

  async setUserActive(session: Session, userId: string, active: boolean): Promise<void> {
    const actor = this.requirePersonnelManager(session);
    if (userId === actor.id) {
      throw new AppError('FORBIDDEN', 'לא ניתן לשנות את הסטטוס של עצמך.');
    }
    const profile = this.db.profiles.find((p) => p.id === userId);
    if (!profile) throw new AppError('NOT_FOUND', 'המשתמש לא נמצא.');
    if (!allowedManageRoles(actor.role).includes(profile.role)) {
      throw new AppError('FORBIDDEN', 'אין הרשאה לנהל משתמש בתפקיד זה.');
    }
    // Mirrors migration 0012: a tombstoned profile cannot be reactivated,
    // and there is nothing left to (de)activate.
    if (profile.deletedAt) {
      throw new AppError('VALIDATION', 'לא ניתן לשנות סטטוס למשתמש שנמחק.');
    }
    if (!active && profile.role === 'system_admin' && profile.active && this.countActiveAdmins() <= 1) {
      throw new AppError('VALIDATION', 'לא ניתן להשבית את מנהל המערכת הפעיל האחרון.');
    }
    profile.active = active;
    this.audit(actor.id, active ? 'user_activated' : 'user_deactivated', 'profile', userId);
    this.persist();
  }

  async deleteUser(session: Session, userId: string): Promise<void> {
    // Mirrors migration 0013's admin_delete_user(): same authorization
    // shape as setUserRole/setUserActive above, plus the open-incident
    // guard, plus tombstoning instead of just deactivating. Idempotent,
    // but only after every permission check has passed -- see the SQL
    // migration's header for why.
    const actor = this.requirePersonnelManager(session);
    if (userId === actor.id) {
      throw new AppError('FORBIDDEN', 'לא ניתן למחוק את עצמך.');
    }
    const profile = this.db.profiles.find((p) => p.id === userId);
    if (!profile) throw new AppError('NOT_FOUND', 'המשתמש לא נמצא.');
    if (!allowedManageRoles(actor.role).includes(profile.role)) {
      throw new AppError('FORBIDDEN', 'אין הרשאה למחוק משתמש בתפקיד זה.');
    }
    if (profile.deletedAt) return; // already deleted: authorized no-op, safe to retry
    if (profile.role === 'system_admin' && profile.active && this.countActiveAdmins() <= 1) {
      throw new AppError('VALIDATION', 'לא ניתן למחוק את מנהל המערכת הפעיל האחרון.');
    }
    const hasOpenIncident = this.db.incidents.some((i) => i.ownerUserId === userId && isOpen(i.status));
    if (hasOpenIncident) {
      throw new AppError('VALIDATION', 'יש לשנות גורם מטפל בתקלות פתוחות לפני מחיקת המשתמש.');
    }
    profile.active = false;
    profile.deletedAt = this.now().toISOString();
    profile.deletedBy = actor.id;
    this.audit(actor.id, 'user_tombstoned', 'profile', userId);
    this.persist();
  }

  // --- pre-provisioned personnel ---
  // Faithful mirror of the 0008 backend rules (role ceilings, normalized
  // emails, claimable-uniqueness, single-claim, fail-closed matching) so
  // the enforcement is unit-testable in-process. The database remains the
  // authority in supabase mode.

  private pendingRows(): PendingPersonnel[] {
    // Databases persisted before this model existed lack the array.
    if (!this.db.pendingPersonnel) this.db.pendingPersonnel = [];
    return this.db.pendingPersonnel;
  }

  private requirePersonnelManager(session: Session): Profile {
    const actor = this.requireSession(session);
    if (!['shift_supervisor', 'professional_manager', 'system_admin'].includes(actor.role)) {
      throw new AppError('FORBIDDEN', 'אין הרשאה לנהל רישומי כוח אדם.');
    }
    return actor;
  }

  /** Demo email registry: a linked profile's Google email is known through
   *  the claimed entry that created it (in supabase mode auth.users is the
   *  authority, read server-side only). */
  private linkedEmailOf(profileId: string): string | null {
    const claimed = this.pendingRows().find((r) => r.status === 'claimed' && r.claimedBy === profileId);
    return claimed ? claimed.email : null;
  }

  /** Mirrors 0008's lazy expiry retirement: an expired pending row for this
   *  email is atomically retired (status 'expired' + audit) so it never
   *  permanently blocks a replacement entry. */
  private retireExpiredPending(email: string, actorId: string, excludeId?: string): void {
    const nowIso = this.now().toISOString();
    const corpse = this.pendingRows().find(
      (r) =>
        r.email === email &&
        r.id !== excludeId &&
        r.status === 'pending' &&
        r.expiresAt !== null &&
        r.expiresAt <= nowIso,
    );
    if (!corpse) return;
    corpse.status = 'expired';
    corpse.updatedAt = nowIso;
    this.audit(actorId, 'personnel_pending_expired', 'pending_personnel', corpse.id, {
      before: JSON.stringify({ email: corpse.email }),
    });
  }

  private validateExpiresAt(expiresAt: string | null | undefined): string | null {
    if (!expiresAt) return null;
    if (expiresAt <= this.now().toISOString()) {
      throw new AppError('VALIDATION', 'מועד התפוגה חייב להיות עתידי.');
    }
    return expiresAt;
  }

  async listPendingPersonnel(session: Session): Promise<PendingPersonnel[]> {
    this.requirePersonnelManager(session);
    return this.pendingRows()
      .map((r) => ({ ...r }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listPersonnel(session: Session): Promise<PersonnelEntry[]> {
    // Mirrors list_personnel(): manager roles only; unified pending+linked
    // view; emails resolved here, never by the caller; no UUID entry needed.
    this.requirePersonnelManager(session);
    const nowIso = this.now().toISOString();
    const pending: PersonnelEntry[] = this.pendingRows()
      .filter((r) => r.status === 'pending' && (!r.expiresAt || r.expiresAt > nowIso))
      .map((r) => ({
        kind: 'pending' as const,
        id: r.id,
        fullName: r.fullName,
        email: r.email,
        role: r.role,
        state: 'pending' as const,
        createdAt: r.createdAt,
      }));
    const linked: PersonnelEntry[] = this.db.profiles.map((p) => ({
      kind: 'linked' as const,
      id: p.id,
      fullName: p.fullName,
      email: this.linkedEmailOf(p.id),
      role: p.role,
      state: p.deletedAt ? ('deleted' as const) : p.active ? ('active' as const) : ('inactive' as const),
      createdAt: p.createdAt,
    }));
    const byCreatedDesc = (a: PersonnelEntry, b: PersonnelEntry) => b.createdAt.localeCompare(a.createdAt);
    return [...linked.sort(byCreatedDesc), ...pending.sort(byCreatedDesc)];
  }

  async createPendingPersonnel(session: Session, rawInput: PendingPersonnelInput): Promise<PendingPersonnel> {
    const actor = this.requirePersonnelManager(session);
    const input = parseOrThrow(pendingPersonnelInputSchema, rawInput);
    if (!allowedAssignRoles(actor.role).includes(input.role)) {
      throw new AppError('FORBIDDEN', 'אין הרשאה להוסיף רישום כוח אדם בתפקיד המבוקש.');
    }
    const expiresAt = this.validateExpiresAt(input.expiresAt);
    // An email already linked to an existing profile -- active OR inactive
    // -- must not get a new pending identity: a pending entry must never
    // silently reactivate or replace a deactivated profile.
    if (
      this.pendingRows().some(
        (r) => r.status === 'claimed' && r.email === input.email && r.claimedBy !== null
          && this.db.profiles.some((p) => p.id === r.claimedBy),
      )
    ) {
      throw new AppError('VALIDATION', 'לכתובת דוא״ל זו כבר קיים משתמש מקושר במערכת.');
    }
    // Lazy retirement of an EXPIRED pending row occupying the claimable
    // slot -- an expired entry must never permanently block re-inviting.
    this.retireExpiredPending(input.email, actor.id);
    if (this.pendingRows().some((r) => r.status === 'pending' && r.email === input.email)) {
      throw new AppError('VALIDATION', 'כבר קיים רישום ממתין לכתובת דוא״ל זו.');
    }
    const ts = this.now().toISOString();
    const row: PendingPersonnel = {
      id: newId(),
      fullName: input.fullName.trim(),
      email: input.email,
      role: input.role,
      status: 'pending',
      createdBy: actor.id,
      createdAt: ts,
      updatedAt: ts,
      expiresAt,
      claimedBy: null,
      claimedAt: null,
      cancelledBy: null,
      cancelledAt: null,
    };
    this.pendingRows().push(row);
    this.audit(actor.id, 'personnel_pending_created', 'pending_personnel', row.id, {
      after: JSON.stringify({ email: row.email, role: row.role, fullName: row.fullName }),
    });
    this.persist();
    return { ...row };
  }

  async updatePendingPersonnel(
    session: Session,
    id: string,
    rawInput: PendingPersonnelInput,
  ): Promise<PendingPersonnel> {
    const actor = this.requirePersonnelManager(session);
    const input = parseOrThrow(pendingPersonnelInputSchema, rawInput);
    const row = this.pendingRows().find((r) => r.id === id);
    if (!row) throw new AppError('NOT_FOUND', 'הרישום לא נמצא.');
    if (row.status !== 'pending') throw new AppError('VALIDATION', 'ניתן לערוך רק רישום ממתין.');
    // The editor's ceiling must cover BOTH the entry's current role and the
    // new one -- a lower role must not take over entries above it.
    const ceiling = allowedAssignRoles(actor.role);
    if (!ceiling.includes(row.role) || !ceiling.includes(input.role)) {
      throw new AppError('FORBIDDEN', 'אין הרשאה לערוך רישום זה.');
    }
    const expiresAt = this.validateExpiresAt(input.expiresAt);
    if (
      input.email !== row.email &&
      this.pendingRows().some(
        (r) => r.status === 'claimed' && r.email === input.email && r.claimedBy !== null
          && this.db.profiles.some((p) => p.id === r.claimedBy),
      )
    ) {
      throw new AppError('VALIDATION', 'לכתובת דוא״ל זו כבר קיים משתמש מקושר במערכת.');
    }
    // Same lazy retirement as create: moving onto an email whose previous
    // pending entry expired must not be blocked by that corpse.
    this.retireExpiredPending(input.email, actor.id, id);
    if (
      input.email !== row.email &&
      this.pendingRows().some((r) => r.id !== id && r.status === 'pending' && r.email === input.email)
    ) {
      throw new AppError('VALIDATION', 'כבר קיים רישום ממתין לכתובת דוא״ל זו.');
    }
    const before = { email: row.email, role: row.role, fullName: row.fullName };
    row.fullName = input.fullName.trim();
    row.email = input.email;
    row.role = input.role;
    row.expiresAt = expiresAt;
    row.updatedAt = this.now().toISOString();
    this.audit(actor.id, 'personnel_pending_updated', 'pending_personnel', row.id, {
      before: JSON.stringify(before),
      after: JSON.stringify({ email: row.email, role: row.role, fullName: row.fullName }),
    });
    this.persist();
    return { ...row };
  }

  async cancelPendingPersonnel(session: Session, id: string): Promise<void> {
    const actor = this.requirePersonnelManager(session);
    const row = this.pendingRows().find((r) => r.id === id);
    if (!row) throw new AppError('NOT_FOUND', 'הרישום לא נמצא.');
    if (row.status !== 'pending') throw new AppError('VALIDATION', 'ניתן לבטל רק רישום ממתין.');
    if (!allowedAssignRoles(actor.role).includes(row.role)) {
      throw new AppError('FORBIDDEN', 'אין הרשאה לבטל רישום זה.');
    }
    const ts = this.now().toISOString();
    row.status = 'cancelled';
    row.cancelledBy = actor.id;
    row.cancelledAt = ts;
    row.updatedAt = ts;
    this.audit(actor.id, 'personnel_pending_cancelled', 'pending_personnel', row.id, {
      before: JSON.stringify({ email: row.email, role: row.role }),
    });
    this.persist();
  }

  async claimPendingProfile(): Promise<Profile | null> {
    // Demo sessions have no external identity provider, so there is never
    // anything to claim through the production interface method.
    return null;
  }

  async bootstrapFirstAdmin(): Promise<Profile | null> {
    // The demo database is always seeded with an active system_admin, so
    // the one-time bootstrap window (a fresh, zero-profile production
    // database) never exists here -- permanently fail closed, exactly as
    // the backend does once an active admin exists.
    return null;
  }

  /**
   * Demo/test stand-in for the server-side claim: the `identity` argument
   * plays the role the backend derives itself from auth.uid()/auth.users/
   * auth.identities (in supabase mode the client can supply nothing -- the
   * RPC takes no arguments). Mirrors 0008's rules: normalization,
   * pending-only, unexpired-only, single-claim, role from the entry, audit
   * record, plus the identity preconditions -- a CONFIRMED email on a
   * GOOGLE provider identity -- and the inactive-profile fail-close: a
   * deactivated existing profile is never returned as authorization and is
   * never reactivated or replaced by a pending entry.
   */
  claimPendingForIdentity(identity: {
    authUserId: string;
    email: string;
    /** Defaults mirror the healthy path; tests override to prove fail-close. */
    provider?: string;
    emailConfirmed?: boolean;
  }): Profile | null {
    const existing = this.db.profiles.find((p) => p.id === identity.authUserId);
    if (existing) {
      // Deactivation is authorization revocation: fail closed, and leave
      // both the profile and any pending entry untouched.
      return existing.active ? { ...existing } : null;
    }
    if ((identity.provider ?? 'google') !== 'google') return null;
    if (!(identity.emailConfirmed ?? true)) return null;

    const email = identity.email.trim().toLowerCase();
    const nowIso = this.now().toISOString();
    const row = this.pendingRows().find(
      (r) => r.email === email && r.status === 'pending' && (!r.expiresAt || r.expiresAt > nowIso),
    );
    if (!row) return null;

    row.status = 'claimed';
    row.claimedBy = identity.authUserId;
    row.claimedAt = nowIso;
    row.updatedAt = nowIso;
    const profile: Profile = {
      id: identity.authUserId,
      fullName: row.fullName,
      role: row.role,
      active: true,
      createdAt: nowIso,
    };
    this.db.profiles.push(profile);
    this.audit(identity.authUserId, 'personnel_pending_claimed', 'pending_personnel', row.id, {
      before: JSON.stringify({ email: row.email, role: row.role }),
      after: JSON.stringify({ profileId: identity.authUserId }),
    });
    this.persist();
    return { ...profile };
  }

  // --- incidents: queries ---

  async listIncidents(
    session: Session,
    filters: IncidentFilters = {},
    sort: IncidentSort = 'priority',
  ): Promise<Incident[]> {
    this.requireCap(session, 'view_all_incidents');
    this.ensureOverdueNotifications();
    const now = this.now();
    // Defensive copies: callers (React Query cache, test code) must not see
    // their previously-fetched objects mutate in place when a later write happens.
    let rows = this.db.incidents.map((i) => ({ ...i }));

    if (filters.openOnly) rows = rows.filter((i) => isOpen(i.status));
    if (filters.terminalOnly) rows = rows.filter((i) => !isOpen(i.status));
    if (filters.status?.length) rows = rows.filter((i) => filters.status!.includes(i.status));
    if (filters.severity?.length) rows = rows.filter((i) => filters.severity!.includes(i.severity));
    if (filters.ownerUserId) rows = rows.filter((i) => i.ownerUserId === filters.ownerUserId);
    if (filters.systemId) rows = rows.filter((i) => i.systemId === filters.systemId);
    if (filters.locationId) rows = rows.filter((i) => i.locationId === filters.locationId);
    if (filters.overdueOnly) rows = rows.filter((i) => isOverdue(i, now));
    if (filters.reportedToOps) rows = rows.filter((i) => i.reportedToOps === filters.reportedToOps);
    if (filters.createdFrom) rows = rows.filter((i) => i.createdAt >= filters.createdFrom!);
    if (filters.createdTo) rows = rows.filter((i) => i.createdAt <= filters.createdTo!);
    if (filters.readinessAtClose?.length) {
      rows = rows.filter(
        (i) => i.readinessAtClose && filters.readinessAtClose!.includes(i.readinessAtClose),
      );
    }
    if (filters.followUpPending) {
      rows = rows.filter((i) => i.followUpRequired && !i.followUpCompletedAt);
    }
    if (filters.rootCauseText) {
      const q = filters.rootCauseText.trim();
      rows = rows.filter((i) => (i.rootCause ?? '').includes(q));
    }
    if (filters.resolutionText) {
      const q = filters.resolutionText.trim();
      rows = rows.filter((i) => (i.resolution ?? '').includes(q));
    }
    if (filters.search?.trim()) {
      const q = filters.search.trim();
      const systemsById = new Map(this.db.systems.map((s) => [s.id, s.name]));
      const locationsById = new Map(this.db.locations.map((l) => [l.id, l.name]));
      const findingsByIncident = new Map<string, string>();
      for (const u of this.db.incidentUpdates) {
        findingsByIncident.set(
          u.incidentId,
          (findingsByIncident.get(u.incidentId) ?? '') + ' ' + u.findings + ' ' + u.actionsTaken,
        );
      }
      rows = rows.filter((i) => {
        const hay = [
          i.number,
          systemsById.get(i.systemId) ?? '',
          locationsById.get(i.locationId) ?? '',
          i.description,
          this.ownerLabel(i.ownerUserId, i.ownerExternalName),
          findingsByIncident.get(i.id) ?? '',
          i.rootCause ?? '',
          i.resolution ?? '',
        ].join(' ');
        return hay.includes(q);
      });
    }

    switch (sort) {
      case 'priority':
        return sortByPriority(rows, now);
      case 'newest':
        return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      case 'oldest':
        return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      case 'next_update':
        return rows.sort((a, b) => {
          const da = a.nextUpdateDue ?? '9999';
          const dbb = b.nextUpdateDue ?? '9999';
          return da.localeCompare(dbb);
        });
      case 'last_update':
        return rows.sort((a, b) => b.lastUpdateAt.localeCompare(a.lastUpdateAt));
    }
  }

  async getIncident(session: Session, id: string): Promise<Incident | null> {
    this.requireCap(session, 'view_all_incidents');
    const incident = this.db.incidents.find((i) => i.id === id);
    return incident ? { ...incident } : null;
  }

  async getIncidentEvents(session: Session, incidentId: string): Promise<IncidentEvent[]> {
    this.requireCap(session, 'view_all_incidents');
    return this.db.incidentEvents
      .filter((e) => e.incidentId === incidentId)
      .sort((a, b) => a.eventTime.localeCompare(b.eventTime))
      .map((e) => ({ ...e }));
  }

  async getIncidentUpdates(session: Session, incidentId: string): Promise<IncidentUpdate[]> {
    this.requireCap(session, 'view_all_incidents');
    return this.db.incidentUpdates
      .filter((u) => u.incidentId === incidentId)
      .sort((a, b) => a.eventTime.localeCompare(b.eventTime))
      .map((u) => ({ ...u }));
  }

  // --- incidents: mutations ---

  async createIncident(session: Session, rawInput: CreateIncidentInput): Promise<Incident> {
    const actor = this.requireCap(session, 'create_incident');
    const input = parseOrThrow(createIncidentSchema, rawInput);
    this.validateOwner(input.ownerUserId);

    const system = this.db.systems.find((s) => s.id === input.systemId && !s.archived);
    if (!system) throw new AppError('VALIDATION', 'יש לבחור מערכת / עמדה פעילה.');
    const location = this.db.locations.find((l) => l.id === input.locationId && !l.archived);
    if (!location) throw new AppError('VALIDATION', 'יש לבחור מיקום פעיל.');

    const ts = this.now().toISOString();
    const incident: Incident = {
      id: newId(),
      number: this.allocateNumber(),
      version: 1,
      systemId: input.systemId,
      locationId: input.locationId,
      description: input.description.trim(),
      severity: input.severity,
      status: input.status,
      operationalImpact: input.operationalImpact.trim(),
      ownerUserId: input.ownerUserId,
      ownerExternalName: input.ownerUserId ? null : (input.ownerExternalName ?? '').trim() || null,
      discoveredAt: input.discoveredAt,
      createdAt: ts,
      createdBy: actor.id,
      updatedAt: ts,
      updatedBy: actor.id,
      lastUpdateAt: ts,
      nextUpdateDue: input.nextUpdateDue,
      noDeadlineReason: input.nextUpdateDue ? null : (input.noDeadlineReason ?? '').trim() || null,
      reportedToOps: input.reportedToOps,
      reportedToOpsRecipient:
        input.reportedToOps === 'yes' ? (input.reportedToOpsRecipient ?? '').trim() || null : null,
      closedAt: null,
      closedBy: null,
      rootCause: null,
      resolution: null,
      readinessAtClose: null,
      followUpNotes: null,
      followUpRequired: false,
      followUpCompletedAt: null,
      followUpCompletedBy: null,
      reopenCount: 0,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
    };
    this.db.incidents.push(incident);

    this.addEvent(incident.id, 'created', actor.id, {
      eventTime: input.discoveredAt,
      note: input.actionsTaken.trim() ? `פעולות שבוצעו עד כה: ${input.actionsTaken.trim()}` : null,
    });
    if (incident.reportedToOps === 'yes' && incident.reportedToOpsRecipient) {
      this.addEvent(incident.id, 'reported_to_ops_change', actor.id, {
        field: 'reported_to_ops_recipient',
        newValue: incident.reportedToOpsRecipient,
        note: `דווח למבצעים: ${incident.reportedToOpsRecipient}`,
      });
    }
    if (input.status !== 'new') {
      this.addEvent(incident.id, 'status_change', actor.id, {
        field: 'status',
        oldValue: 'new',
        newValue: input.status,
      });
    }
    this.audit(actor.id, 'incident_created', 'incident', incident.id, {
      incidentNumber: incident.number,
      after: JSON.stringify({ number: incident.number, severity: incident.severity, status: incident.status }),
    });

    if (incident.ownerUserId && incident.ownerUserId !== actor.id) {
      this.notify(incident.ownerUserId, 'incident_assigned', `תקלה ${incident.number} הוקצתה אליך.`, {
        incidentId: incident.id,
        dedupeKey: `assign-${incident.id}-create`,
      });
    }
    this.persist();
    return { ...incident };
  }

  async acknowledgeIncident(
    session: Session,
    incidentId: string,
    expectedVersion: number,
  ): Promise<Incident> {
    const actor = this.requireCap(session, 'acknowledge_incident');
    const incident = this.getIncidentOrThrow(incidentId);
    this.checkVersion(incident, expectedVersion);
    if (incident.status !== 'new') {
      throw new AppError('INVALID_TRANSITION', 'ניתן לאשר קבלה רק לתקלה בסטטוס "חדשה".');
    }
    const ts = this.now().toISOString();
    incident.status = 'acknowledged';
    incident.version += 1;
    incident.updatedAt = ts;
    incident.updatedBy = actor.id;
    incident.lastUpdateAt = ts;
    this.addEvent(incidentId, 'acknowledged', actor.id);
    this.audit(actor.id, 'incident_acknowledged', 'incident', incidentId, {
      incidentNumber: incident.number,
    });
    this.persist();
    return { ...incident };
  }

  /**
   * Full update by operational roles. Also carries protected-field changes
   * (status, severity, impact, owner, deadline), each producing its own event.
   */
  async updateIncident(
    session: Session,
    incidentId: string,
    rawInput: UpdateIncidentInput,
  ): Promise<Incident> {
    const actor = this.requireCap(session, 'full_update');
    const input = parseOrThrow(updateIncidentSchema, rawInput);
    const incident = this.getIncidentOrThrow(incidentId);
    this.checkVersion(incident, input.expectedVersion);
    if (incident.status === 'closed') {
      throw new AppError(
        'INVALID_TRANSITION',
        'תקלה סגורה אינה ניתנת לעדכון. יש לפתוח אותה מחדש תחילה.',
      );
    }
    if (!canTransition(incident.status, input.status)) {
      throw new AppError('INVALID_TRANSITION', transitionError(incident.status, input.status));
    }
    this.validateOwner(input.ownerUserId);

    const ts = this.now().toISOString();
    const update: IncidentUpdate = {
      id: newId(),
      incidentId,
      authorId: actor.id,
      eventTime: input.eventTime,
      serverTime: ts,
      actionsTaken: input.actionsTaken.trim(),
      findings: input.findings.trim(),
      nextSteps: input.nextSteps.trim(),
      createdAt: ts,
    };
    this.db.incidentUpdates.push(update);
    this.addEvent(incidentId, 'update', actor.id, {
      eventTime: input.eventTime,
      refId: update.id,
    });

    // Protected-field diffs → dedicated events
    if (input.status !== incident.status) {
      this.addEvent(incidentId, 'status_change', actor.id, {
        field: 'status',
        oldValue: incident.status,
        newValue: input.status,
        note: input.changeReason.trim() || null,
      });
    }
    if (input.severity !== incident.severity) {
      this.addEvent(incidentId, 'severity_change', actor.id, {
        field: 'severity',
        oldValue: incident.severity,
        newValue: input.severity,
        note: input.changeReason.trim() || null,
      });
      this.audit(actor.id, 'incident_severity_changed', 'incident', incidentId, {
        incidentNumber: incident.number,
        before: JSON.stringify({ severity: incident.severity }),
        after: JSON.stringify({ severity: input.severity }),
      });
    }
    if (input.operationalImpact.trim() !== incident.operationalImpact) {
      this.addEvent(incidentId, 'impact_change', actor.id, {
        field: 'operational_impact',
        oldValue: incident.operationalImpact,
        newValue: input.operationalImpact.trim(),
      });
    }
    const newOwnerLabel = this.ownerLabel(input.ownerUserId, input.ownerExternalName);
    const oldOwnerLabel = this.ownerLabel(incident.ownerUserId, incident.ownerExternalName);
    const ownerChanged =
      input.ownerUserId !== incident.ownerUserId ||
      ((input.ownerExternalName ?? '').trim() || null) !== incident.ownerExternalName;
    if (ownerChanged) {
      this.addEvent(incidentId, 'assignment_change', actor.id, {
        field: 'owner',
        oldValue: oldOwnerLabel,
        newValue: newOwnerLabel,
      });
      this.audit(actor.id, 'incident_assigned', 'incident', incidentId, {
        incidentNumber: incident.number,
        before: JSON.stringify({ owner: oldOwnerLabel }),
        after: JSON.stringify({ owner: newOwnerLabel }),
      });
      if (input.ownerUserId && input.ownerUserId !== actor.id) {
        this.notify(input.ownerUserId, 'incident_assigned', `תקלה ${incident.number} הוקצתה אליך.`, {
          incidentId,
          dedupeKey: `assign-${incidentId}-${ts}`,
        });
      }
    }
    if ((input.nextUpdateDue ?? null) !== incident.nextUpdateDue) {
      this.addEvent(incidentId, 'deadline_change', actor.id, {
        field: 'next_update_due',
        oldValue: incident.nextUpdateDue,
        newValue: input.nextUpdateDue,
        note: input.nextUpdateDue ? null : `ללא צפי כרגע: ${(input.noDeadlineReason ?? '').trim()}`,
      });
    }
    const newRecipient =
      input.reportedToOps === 'yes' ? (input.reportedToOpsRecipient ?? '').trim() || null : null;
    if (input.reportedToOps !== incident.reportedToOps || newRecipient !== incident.reportedToOpsRecipient) {
      this.addEvent(incidentId, 'reported_to_ops_change', actor.id, {
        field: 'reported_to_ops_recipient',
        oldValue: incident.reportedToOpsRecipient,
        newValue: newRecipient,
        note: `דווח למבצעים: ${reportedToOpsLabels[input.reportedToOps]}${newRecipient ? ` (${newRecipient})` : ''}`,
      });
    }

    incident.status = input.status;
    incident.severity = input.severity;
    incident.operationalImpact = input.operationalImpact.trim();
    incident.ownerUserId = input.ownerUserId;
    incident.ownerExternalName = input.ownerUserId
      ? null
      : (input.ownerExternalName ?? '').trim() || null;
    incident.nextUpdateDue = input.nextUpdateDue;
    incident.noDeadlineReason = input.nextUpdateDue
      ? null
      : (input.noDeadlineReason ?? '').trim() || null;
    incident.reportedToOps = input.reportedToOps;
    incident.reportedToOpsRecipient = newRecipient;
    incident.version += 1;
    incident.updatedAt = ts;
    incident.updatedBy = actor.id;
    incident.lastUpdateAt = ts;

    this.audit(actor.id, 'incident_updated', 'incident', incidentId, {
      incidentNumber: incident.number,
    });
    this.persist();
    return { ...incident };
  }

  /** Technician update: content only. Protected fields are unreachable here. */
  async technicianUpdate(
    session: Session,
    incidentId: string,
    rawInput: TechnicianUpdateInput,
  ): Promise<Incident> {
    const actor = this.requireCap(session, 'technical_update');
    const input = parseOrThrow(technicianUpdateSchema, rawInput);
    const incident = this.getIncidentOrThrow(incidentId);
    if (!canTechnicianUpdate(actor.id, incident)) {
      throw new AppError('FORBIDDEN', 'ניתן להוסיף עדכון טכני רק לתקלה פתוחה המוקצית אליך.');
    }
    this.checkVersion(incident, input.expectedVersion);

    const ts = this.now().toISOString();
    const update: IncidentUpdate = {
      id: newId(),
      incidentId,
      authorId: actor.id,
      eventTime: input.eventTime,
      serverTime: ts,
      actionsTaken: input.actionsTaken.trim(),
      findings: input.findings.trim(),
      nextSteps: input.nextSteps.trim(),
      createdAt: ts,
    };
    this.db.incidentUpdates.push(update);
    this.addEvent(incidentId, 'update', actor.id, { eventTime: input.eventTime, refId: update.id });

    incident.version += 1;
    incident.updatedAt = ts;
    incident.updatedBy = actor.id;
    incident.lastUpdateAt = ts;
    this.audit(actor.id, 'incident_technical_update', 'incident', incidentId, {
      incidentNumber: incident.number,
    });
    this.persist();
    return { ...incident };
  }

  async assignIncident(
    session: Session,
    incidentId: string,
    rawInput: AssignIncidentInput,
  ): Promise<Incident> {
    const actor = this.requireCap(session, 'assign_incident');
    const input = parseOrThrow(assignIncidentSchema, rawInput);
    const incident = this.getIncidentOrThrow(incidentId);
    this.checkVersion(incident, input.expectedVersion);
    if (incident.status === 'closed') {
      throw new AppError('INVALID_TRANSITION', 'לא ניתן לשנות גורם מטפל בתקלה סגורה.');
    }
    this.validateOwner(input.ownerUserId);

    const ts = this.now().toISOString();
    const oldLabel = this.ownerLabel(incident.ownerUserId, incident.ownerExternalName);
    const newLabel = this.ownerLabel(input.ownerUserId, input.ownerExternalName);

    this.addEvent(incidentId, 'assignment_change', actor.id, {
      field: 'owner',
      oldValue: oldLabel,
      newValue: newLabel,
      note: input.note.trim() || null,
    });
    this.audit(actor.id, 'incident_assigned', 'incident', incidentId, {
      incidentNumber: incident.number,
      before: JSON.stringify({ owner: oldLabel }),
      after: JSON.stringify({ owner: newLabel }),
    });
    if (input.ownerUserId && input.ownerUserId !== actor.id) {
      this.notify(input.ownerUserId, 'incident_assigned', `תקלה ${incident.number} הוקצתה אליך.`, {
        incidentId,
        dedupeKey: `assign-${incidentId}-${ts}`,
      });
    }

    incident.ownerUserId = input.ownerUserId;
    incident.ownerExternalName = input.ownerUserId
      ? null
      : (input.ownerExternalName ?? '').trim() || null;
    incident.version += 1;
    incident.updatedAt = ts;
    incident.updatedBy = actor.id;
    incident.lastUpdateAt = ts;
    this.persist();
    return { ...incident };
  }

  async closeIncident(
    session: Session,
    incidentId: string,
    rawInput: CloseIncidentInput,
  ): Promise<Incident> {
    const actor = this.requireCap(session, 'close_incident');
    const input = parseOrThrow(closeIncidentSchema, rawInput);
    const incident = this.getIncidentOrThrow(incidentId);
    this.checkVersion(incident, input.expectedVersion);
    if (incident.status === 'closed') {
      throw new AppError('INVALID_TRANSITION', 'התקלה כבר סגורה.');
    }
    const fullyReady = input.readiness === 'full';
    if (!fullyReady) this.validateOwner(input.ownerUserId ?? null);

    const ts = this.now().toISOString();
    const oldReportedToOps = incident.reportedToOps;
    const oldRecipient = incident.reportedToOpsRecipient;
    incident.rootCause = input.rootCause.trim();
    incident.resolution = input.resolution.trim();
    incident.followUpNotes = input.followUpNotes.trim() || null;
    incident.followUpRequired = !fullyReady;
    incident.reportedToOps = input.reportedToOps;
    incident.reportedToOpsRecipient =
      input.reportedToOps === 'yes' ? (input.reportedToOpsRecipient ?? '').trim() || null : null;
    incident.version += 1;
    incident.updatedAt = ts;
    incident.updatedBy = actor.id;
    incident.lastUpdateAt = ts;

    if (fullyReady) {
      // Full readiness: the incident actually closes.
      incident.status = 'closed';
      incident.closedAt = ts;
      incident.closedBy = actor.id;
      incident.readinessAtClose = input.readiness;
      incident.nextUpdateDue = null;
      incident.noDeadlineReason = 'התקלה נסגרה';

      this.addEvent(incidentId, 'closed', actor.id, {
        newValue: input.readiness,
        note: `סיבת התקלה: ${input.rootCause.trim()}\nהפתרון שבוצע: ${input.resolution.trim()}`,
      });
      this.audit(actor.id, 'incident_closed', 'incident', incidentId, {
        incidentNumber: incident.number,
        after: JSON.stringify({ readiness: input.readiness, rootCause: incident.rootCause }),
      });
      if (incident.reportedToOps !== oldReportedToOps || incident.reportedToOpsRecipient !== oldRecipient) {
        this.addEvent(incidentId, 'reported_to_ops_change', actor.id, {
          field: 'reported_to_ops_recipient',
          oldValue: oldRecipient,
          newValue: incident.reportedToOpsRecipient,
          note: `דווח למבצעים: ${reportedToOpsLabels[incident.reportedToOps]}${incident.reportedToOpsRecipient ? ` (${incident.reportedToOpsRecipient})` : ''}`,
        });
      }
    } else {
      // Incomplete readiness: the incident stays active as "כשירות חלקית" —
      // it is never marked closed while follow-up is still outstanding.
      // readinessAtClose is left untouched: it only ever describes readiness
      // AT AN ACTUAL CLOSE, and this incident has not closed.
      const oldStatus = incident.status;
      incident.status = 'partial_readiness';
      incident.ownerUserId = input.ownerUserId ?? null;
      incident.ownerExternalName = input.ownerUserId
        ? null
        : (input.ownerExternalName ?? '').trim() || null;
      if (!incident.nextUpdateDue) {
        incident.noDeadlineReason = 'התקלה נותרה פעילה עם כשירות לא מלאה, ממתינה להשלמת פעולות המשך';
      }

      this.addEvent(incidentId, 'status_change', actor.id, {
        field: 'status',
        oldValue: oldStatus,
        newValue: 'partial_readiness',
        note: `סיבת התקלה: ${input.rootCause.trim()}\nהפתרון החלקי שבוצע: ${input.resolution.trim()}\nפעולות המשך: ${incident.followUpNotes}\nגורם מטפל אחראי המשך: ${this.ownerLabel(incident.ownerUserId, incident.ownerExternalName)}`,
      });
      this.audit(actor.id, 'incident_partial_readiness', 'incident', incidentId, {
        incidentNumber: incident.number,
        after: JSON.stringify({ readiness: input.readiness, rootCause: incident.rootCause }),
      });
      if (incident.reportedToOps !== oldReportedToOps || incident.reportedToOpsRecipient !== oldRecipient) {
        this.addEvent(incidentId, 'reported_to_ops_change', actor.id, {
          field: 'reported_to_ops_recipient',
          oldValue: oldRecipient,
          newValue: incident.reportedToOpsRecipient,
          note: `דווח למבצעים: ${reportedToOpsLabels[incident.reportedToOps]}${incident.reportedToOpsRecipient ? ` (${incident.reportedToOpsRecipient})` : ''}`,
        });
      }
    }
    this.persist();
    return { ...incident };
  }

  async cancelIncident(
    session: Session,
    incidentId: string,
    rawInput: CancelIncidentInput,
  ): Promise<Incident> {
    const actor = this.requireCap(session, 'cancel_incident');
    const input = parseOrThrow(cancelIncidentSchema, rawInput);
    const incident = this.getIncidentOrThrow(incidentId);
    this.checkVersion(incident, input.expectedVersion);
    if (!isOpen(incident.status)) {
      throw new AppError('INVALID_TRANSITION', 'לא ניתן לבטל תקלה שכבר סגורה או מבוטלת.');
    }
    const eventTime = new Date(input.eventTime);
    if (eventTime < new Date(incident.discoveredAt) || eventTime.getTime() > this.now().getTime() + 5 * 60_000) {
      throw new AppError('VALIDATION', 'מועד הביטול אינו תקין.');
    }

    const oldStatus = incident.status;
    const reason = input.cancellationReason.trim();
    const ts = this.now().toISOString();
    incident.status = 'cancelled';
    incident.cancelledAt = input.eventTime;
    incident.cancelledBy = actor.id;
    incident.cancellationReason = reason;
    incident.nextUpdateDue = null;
    incident.noDeadlineReason = 'התקלה בוטלה';
    incident.followUpRequired = false;
    incident.version += 1;
    incident.updatedAt = ts;
    incident.updatedBy = actor.id;
    incident.lastUpdateAt = ts;

    this.addEvent(incidentId, 'cancelled', actor.id, {
      field: 'status',
      oldValue: oldStatus,
      newValue: 'cancelled',
      note: reason,
      eventTime: input.eventTime,
    });
    this.audit(actor.id, 'incident_cancelled', 'incident', incidentId, {
      incidentNumber: incident.number,
      before: JSON.stringify({ status: oldStatus }),
      after: JSON.stringify({ status: 'cancelled', cancellationReason: reason }),
    });
    this.persist();
    return { ...incident };
  }

  async reopenIncident(
    session: Session,
    incidentId: string,
    rawInput: ReopenIncidentInput,
  ): Promise<Incident> {
    const actor = this.requireCap(session, 'reopen_incident');
    const input = parseOrThrow(reopenIncidentSchema, rawInput);
    const incident = this.getIncidentOrThrow(incidentId);
    this.checkVersion(incident, input.expectedVersion);
    if (incident.status !== 'closed') {
      throw new AppError('INVALID_TRANSITION', 'ניתן לפתוח מחדש רק תקלה סגורה.');
    }
    this.validateOwner(input.ownerUserId);

    const ts = this.now().toISOString();
    this.addEvent(incidentId, 'reopened', actor.id, {
      note: input.reason.trim(),
      oldValue: 'closed',
      newValue: 'reopened',
    });
    this.audit(actor.id, 'incident_reopened', 'incident', incidentId, {
      incidentNumber: incident.number,
      after: JSON.stringify({ reason: input.reason.trim() }),
    });

    incident.status = 'reopened';
    incident.ownerUserId = input.ownerUserId;
    incident.ownerExternalName = input.ownerUserId
      ? null
      : (input.ownerExternalName ?? '').trim() || null;
    incident.nextUpdateDue = input.nextUpdateDue;
    incident.noDeadlineReason = null;
    incident.reopenCount += 1;
    // Closure record stays in the timeline event; live fields reset so the
    // incident is fully open again.
    incident.closedAt = null;
    incident.closedBy = null;
    incident.followUpRequired = false;
    incident.followUpCompletedAt = null;
    incident.followUpCompletedBy = null;
    incident.version += 1;
    incident.updatedAt = ts;
    incident.updatedBy = actor.id;
    incident.lastUpdateAt = ts;

    if (incident.ownerUserId && incident.ownerUserId !== actor.id) {
      this.notify(
        incident.ownerUserId,
        'incident_reopened',
        `תקלה ${incident.number} נפתחה מחדש והוקצתה אליך.`,
        { incidentId, dedupeKey: `reopen-${incidentId}-${ts}` },
      );
    }
    this.persist();
    return { ...incident };
  }

  async addCorrection(session: Session, incidentId: string, rawInput: CorrectionInput): Promise<void> {
    const actor = this.requireSession(session);
    const input = parseOrThrow(correctionSchema, rawInput);
    const incident = this.getIncidentOrThrow(incidentId);
    const referenced =
      this.db.incidentUpdates.find((u) => u.id === input.refId) ??
      this.db.incidentEvents.find((e) => e.id === input.refId);
    if (!referenced || referenced.incidentId !== incidentId) {
      throw new AppError('NOT_FOUND', 'הרישום המקורי לתיקון לא נמצא.');
    }
    const isAuthor =
      'authorId' in referenced ? referenced.authorId === actor.id : referenced.actorId === actor.id;
    if (!hasCapability(actor.role, 'full_update', this.db.policy, actor.id) && !isAuthor) {
      throw new AppError('FORBIDDEN', 'ניתן לתקן רק רישום שנכתב על ידך.');
    }
    this.addEvent(incidentId, 'correction', actor.id, {
      refId: input.refId,
      note: input.text.trim(),
    });
    this.audit(actor.id, 'incident_correction', 'incident', incidentId, {
      incidentNumber: incident.number,
      after: JSON.stringify({ refId: input.refId }),
    });
    this.persist();
  }

  async completeFollowUp(session: Session, incidentId: string, note: string): Promise<Incident> {
    const actor = this.requireCap(session, 'complete_follow_up');
    const incident = this.getIncidentOrThrow(incidentId);
    if (!incident.followUpRequired || incident.followUpCompletedAt) {
      throw new AppError('VALIDATION', 'לתקלה זו אין פעולות המשך פתוחות.');
    }
    if (!note.trim()) {
      throw new AppError('VALIDATION', 'יש לפרט מה בוצע להשלמת פעולות ההמשך.');
    }
    const ts = this.now().toISOString();
    incident.followUpCompletedAt = ts;
    incident.followUpCompletedBy = actor.id;
    incident.version += 1;
    incident.updatedAt = ts;
    incident.updatedBy = actor.id;
    this.addEvent(incidentId, 'follow_up_completed', actor.id, { note: note.trim() });
    this.audit(actor.id, 'incident_follow_up_completed', 'incident', incidentId, {
      incidentNumber: incident.number,
    });
    this.persist();
    return { ...incident };
  }

  // --- handovers ---

  async listHandovers(session: Session): Promise<Handover[]> {
    this.requireSession(session);
    return [...this.db.handovers].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getHandover(session: Session, id: string) {
    this.requireSession(session);
    const handover = this.db.handovers.find((h) => h.id === id);
    if (!handover) return null;
    return {
      handover,
      items: this.db.handoverItems.filter((i) => i.handoverId === id),
      addenda: this.db.handoverAddenda
        .filter((a) => a.handoverId === id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    };
  }

  async createHandover(session: Session, rawInput: CreateHandoverInput): Promise<Handover> {
    const actor = this.requireCap(session, 'create_handover');
    const input = parseOrThrow(createHandoverSchema, rawInput);
    const toUser = this.db.profiles.find((p) => p.id === input.toUserId);
    if (!toUser || !toUser.active) {
      throw new AppError('VALIDATION', 'יש לבחור אחמ״ש נכנס פעיל.');
    }
    if (toUser.id === actor.id) {
      throw new AppError('VALIDATION', 'לא ניתן להעביר משמרת לעצמך.');
    }

    const ts = this.now().toISOString();
    const handover: Handover = {
      id: newId(),
      createdBy: actor.id,
      createdAt: ts,
      toUserId: input.toUserId,
      generalNote: (input.generalNote ?? '').trim(),
      status: 'pending',
      acceptedAt: null,
      acceptedBy: null,
    };
    this.db.handovers.push(handover);

    // Snapshot: all open incidents + closed incidents with pending follow-up.
    const included = this.db.incidents.filter(
      (i) => isOpen(i.status) || (i.followUpRequired && !i.followUpCompletedAt),
    );
    const systemsById = new Map(this.db.systems.map((s) => [s.id, s.name]));
    const locationsById = new Map(this.db.locations.map((l) => [l.id, l.name]));
    for (const inc of included) {
      const lastUpdate = this.db.incidentUpdates
        .filter((u) => u.incidentId === inc.id)
        .sort((a, b) => b.eventTime.localeCompare(a.eventTime))[0];
      const item: HandoverItem = {
        id: newId(),
        handoverId: handover.id,
        incidentId: inc.id,
        note: (input.itemNotes[inc.id] ?? '').trim(),
        snapshotNumber: inc.number,
        snapshotStatus: inc.status,
        snapshotSeverity: inc.severity,
        snapshotOwnerLabel: this.ownerLabel(inc.ownerUserId, inc.ownerExternalName),
        snapshotSystemName: systemsById.get(inc.systemId) ?? '',
        snapshotLocationName: locationsById.get(inc.locationId) ?? '',
        snapshotImpact: inc.operationalImpact,
        snapshotLastAction: lastUpdate?.actionsTaken ?? '',
        snapshotNextSteps: lastUpdate?.nextSteps ?? '',
        snapshotNextUpdateDue: inc.nextUpdateDue,
      };
      this.db.handoverItems.push(item);
      this.addEvent(inc.id, 'handover_included', actor.id, { refId: handover.id });
    }

    this.notify(
      input.toUserId,
      'handover_pending',
      `העברת משמרת מ${actor.fullName} ממתינה לאישורך.`,
      { handoverId: handover.id, dedupeKey: `handover-${handover.id}` },
    );
    this.audit(actor.id, 'handover_created', 'handover', handover.id, {
      after: JSON.stringify({ toUserId: input.toUserId, items: included.length }),
    });
    this.persist();
    return { ...handover };
  }

  async acceptHandover(session: Session, handoverId: string): Promise<Handover> {
    const actor = this.requireCap(session, 'accept_handover');
    const handover = this.db.handovers.find((h) => h.id === handoverId);
    if (!handover) throw new AppError('NOT_FOUND', 'העברת המשמרת לא נמצאה.');
    if (handover.status === 'accepted') {
      throw new AppError('VALIDATION', 'העברת המשמרת כבר אושרה.');
    }
    if (handover.toUserId !== actor.id) {
      throw new AppError('FORBIDDEN', 'רק האחמ״ש הנכנס שנבחר יכול לאשר את ההעברה.');
    }
    const ts = this.now().toISOString();
    handover.status = 'accepted';
    handover.acceptedAt = ts;
    handover.acceptedBy = actor.id;

    for (const item of this.db.handoverItems.filter((i) => i.handoverId === handoverId)) {
      this.addEvent(item.incidentId, 'handover_accepted', actor.id, { refId: handoverId });
    }
    this.audit(actor.id, 'handover_accepted', 'handover', handoverId);
    this.persist();
    return { ...handover };
  }

  async addHandoverAddendum(session: Session, handoverId: string, text: string): Promise<void> {
    const actor = this.requireCap(session, 'create_handover');
    const handover = this.db.handovers.find((h) => h.id === handoverId);
    if (!handover) throw new AppError('NOT_FOUND', 'העברת המשמרת לא נמצאה.');
    if (handover.status !== 'accepted') {
      throw new AppError('VALIDATION', 'תוספת ניתן להוסיף רק להעברה שאושרה. עד אז ניתן לבטל וליצור העברה חדשה.');
    }
    if (!text.trim()) throw new AppError('VALIDATION', 'יש להזין תוכן לתוספת.');
    const addendum: HandoverAddendum = {
      id: newId(),
      handoverId,
      authorId: actor.id,
      text: text.trim(),
      createdAt: this.now().toISOString(),
    };
    this.db.handoverAddenda.push(addendum);
    this.audit(actor.id, 'handover_addendum', 'handover', handoverId);
    this.persist();
  }

  // --- notifications ---

  private ensureOverdueNotifications(): void {
    const now = this.now();
    for (const inc of this.db.incidents) {
      if (!isOpen(inc.status) || !inc.nextUpdateDue || !inc.ownerUserId) continue;
      if (new Date(inc.nextUpdateDue).getTime() < now.getTime()) {
        this.notify(
          inc.ownerUserId,
          'update_overdue',
          `עבר מועד העדכון לתקלה ${inc.number}.`,
          { incidentId: inc.id, dedupeKey: `overdue-${inc.id}-${inc.nextUpdateDue}` },
        );
      }
    }
    this.persist();
  }

  async listNotifications(session: Session): Promise<AppNotification[]> {
    const actor = this.requireSession(session);
    this.ensureOverdueNotifications();
    return this.db.notifications
      .filter((n) => n.userId === actor.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ dedupeKey: _dedupeKey, ...n }) => n);
  }

  async markNotificationRead(session: Session, id: string): Promise<void> {
    const actor = this.requireSession(session);
    const notification = this.db.notifications.find((n) => n.id === id);
    if (!notification || notification.userId !== actor.id) {
      throw new AppError('NOT_FOUND', 'ההתראה לא נמצאה.');
    }
    notification.read = true;
    this.persist();
  }

  async markAllNotificationsRead(session: Session): Promise<void> {
    const actor = this.requireSession(session);
    for (const n of this.db.notifications) {
      if (n.userId === actor.id) n.read = true;
    }
    this.persist();
  }

  // --- audit ---

  async listAuditLogs(session: Session, filters: AuditFilters = {}): Promise<AuditLog[]> {
    const actor = this.requireSession(session);
    const full = hasCapability(actor.role, 'view_audit_full', this.db.policy, actor.id);
    const incidentsOnly = hasCapability(actor.role, 'view_audit_incidents', this.db.policy, actor.id);
    if (!full && !incidentsOnly) {
      throw new AppError('FORBIDDEN', 'אין לך הרשאה לצפות ביומן הפעילות.');
    }
    let rows = [...this.db.auditLogs];
    if (!full) rows = rows.filter((r) => r.entityType === 'incident' || r.entityType === 'handover');
    if (filters.actorId) rows = rows.filter((r) => r.actorId === filters.actorId);
    if (filters.action) rows = rows.filter((r) => r.action.includes(filters.action!));
    if (filters.incidentNumber) {
      rows = rows.filter((r) => r.incidentNumber?.includes(filters.incidentNumber!.trim()));
    }
    if (filters.from) rows = rows.filter((r) => r.createdAt >= filters.from!);
    if (filters.to) rows = rows.filter((r) => r.createdAt <= filters.to!);
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async recordExport(session: Session, info: ExportAuditInfo): Promise<void> {
    const actor = this.requireSession(session);
    if (!hasCapability(actor.role, 'export_data', this.db.policy, actor.id)) {
      throw new AppError('FORBIDDEN', 'אין לך הרשאה לייצא נתונים.');
    }
    this.audit(actor.id, 'export_generated', 'export', info.exportType, {
      after: JSON.stringify({ type: info.exportType, filters: info.filtersDescription }),
    });
    this.persist();
  }

  async canExport(session: Session): Promise<boolean> {
    try {
      const actor = this.requireSession(session);
      return hasCapability(actor.role, 'export_data', this.db.policy, actor.id);
    } catch {
      return false;
    }
  }
}
