// LocalDemoRepository: the demo-mode backend. It enforces permissions, status
// transitions, atomic numbering, and optimistic concurrency exactly as the real
// backend (Supabase RLS + RPCs) would — it is NOT a UI-side convenience layer.
// It is still local demo data and must never be presented as a secured backend.
import type {
  AppNotification,
  AuditLog,
  Incident,
  IncidentCauseAssessment,
  IncidentClosureClassification,
  IncidentDomain,
  IncidentEvent,
  IncidentRelation,
  IncidentSummary,
  IncidentTreatmentAction,
  IncidentUpdate,
  LocationCategory,
  LocationRecord,
  PendingPersonnel,
  PersonnelEntry,
  Profile,
  Role,
  SimilarIncidentSuggestion,
  SuspectedCause,
  SystemCategory,
  SystemRecord,
  EventType,
} from '../../domain/types';
import { selectSimilarIncidentSuggestions, incidentToSimilarityCandidate } from '../../domain/similarity';
import type { TreatmentActionInput } from '../../domain/schemas';
import { isOpen } from '../../domain/types';
import { computeIncidentAnalytics, type AnalyticsFilters, type IncidentAnalytics } from '../../domain/analyticsSummary';
import { LOCATION_CATEGORY_ORDER, SYSTEM_CATEGORY_ORDER, reportedToOpsLabels } from '../../domain/labels';
import { hasCapability, canTechnicianUpdate, allowedAssignRoles, allowedManageRoles, type Capability } from '../../domain/permissions';
import { canTransition, transitionError } from '../../domain/transitions';
import { sortByPriority } from '../../domain/overdue';
import {
  assignIncidentSchema,
  cancelIncidentSchema,
  closeIncidentSchema,
  correctionSchema,
  createIncidentSchema,
  pendingPersonnelInputSchema,
  renamePersonnelInputSchema,
  reopenIncidentSchema,
  technicianUpdateSchema,
  updateIncidentSchema,
  type AssignIncidentInput,
  type CancelIncidentInput,
  type CloseIncidentInput,
  type CorrectionInput,
  type CreateIncidentInput,
  type PendingPersonnelInput,
  type RenamePersonnelInput,
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
  AuditLogPage,
  ExportAuditInfo,
  IncidentFilters,
  IncidentSort,
  ReferenceDataDeleteOutcome,
  ReferenceDataMoveDirection,
  Repository,
  Session,
} from '../repository';
import type { DemoDatabase, DemoStorage, StoredIncidentRelation } from './storage';
import { emptyDatabase } from './storage';
import { buildSeed } from './seed';

const CONFLICT_MSG =
  'התקלה עודכנה על ידי משתמש אחר מאז שנפתח המסך. יש לרענן את הדף ולבדוק את הנתונים לפני שמירה חוזרת.';
const SYSTEM_NAME_CONFLICT_MSG =
  'כבר קיימת מערכת / עמדה בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים.';
const LOCATION_NAME_CONFLICT_MSG =
  'כבר קיים מיקום בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים.';

type ReferenceRecord = SystemRecord | LocationRecord;

function normalizedReferenceName(name: string): string {
  return name.trim().toLocaleLowerCase('he-IL');
}

/**
 * Ordering WITHIN one category: displayOrder, then a deterministic
 * name/id tie-break. Never compares category -- every call site either
 * already filtered to one category, or (listSystems/listLocations) applies
 * categoryListingRank first via compareReferenceRecordsForListing below.
 */
function compareReferenceRecords(a: ReferenceRecord, b: ReferenceRecord): number {
  return (
    a.displayOrder - b.displayOrder ||
    normalizedReferenceName(a.name).localeCompare(normalizedReferenceName(b.name), 'he') ||
    a.id.localeCompare(b.id)
  );
}

/** Fixed category display rank, mirroring the database enum's declaration
 *  order (system_category/location_category, migration 0041). */
function categoryRank(order: readonly string[], category: string): number {
  const index = order.indexOf(category);
  return index === -1 ? order.length : index;
}

/** Full listing order: fixed category order first, then compareReferenceRecords
 *  within that category. Only used by listSystems/listLocations -- every
 *  other reference-data operation below is explicitly scoped to a single
 *  category and never needs to rank across categories. */
function compareReferenceRecordsForListing(order: readonly string[]) {
  return (a: ReferenceRecord, b: ReferenceRecord): number =>
    categoryRank(order, a.category) - categoryRank(order, b.category) || compareReferenceRecords(a, b);
}

function parseOrThrow<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const msg = result.error.issues[0]?.message ?? 'קלט לא תקין';
    throw new AppError('VALIDATION', msg);
  }
  return result.data;
}

/** Mirrors format_external_handler_snapshot (migration 0032): a single
 *  human-readable snapshot of all three external-handler fields, used
 *  identically for both old_value and new_value on a field='external_handler'
 *  event -- so a contact-only change (name unchanged) is still visibly
 *  distinct even when the organization name itself doesn't change. */
function externalHandlerSnapshot(
  name: string | null,
  contactPerson: string | null,
  contactDetails: string | null,
): string {
  if (!name && !contactPerson && !contactDetails) return 'ללא גורם מטפל חיצוני';
  const parts = [name || 'ללא שם גורם'];
  if (contactPerson) parts.push(`איש קשר: ${contactPerson}`);
  if (contactDetails) parts.push(`פרטי קשר: ${contactDetails}`);
  return parts.join(' · ');
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
      // Demo databases persisted before this feature existed have no
      // classification arrays at all -- backfill to empty, exactly like
      // pendingPersonnel's own optional-field handling elsewhere in this
      // class. No incident is touched; this only ensures the arrays this
      // class pushes onto actually exist.
      this.db.incidentCauseAssessments ??= [];
      this.db.incidentTreatmentActions ??= [];
      this.db.incidentClosures ??= [];
      this.db.incidentRelations ??= [];
      this.backfillReferenceDataOrder();
      this.backfillReferenceDataCategory();
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

  /**
   * Demo databases persisted before reference-data ordering have no
   * displayOrder. Backfill them in place using their former visible order
   * (name, then id). No record is removed, renamed, merged, or reactivated.
   *
   * Scoped per category (grouping by each record's current `category`
   * value, including `undefined` as its own group for data that predates
   * categories entirely -- backfillReferenceDataCategory runs right after
   * this and assigns those 'other'): ordering is independent per category,
   * so this must never renumber across a category boundary. Only actual
   * drift triggers a change -- an already-correctly-ordered database is
   * never rewritten just because its schema version marker is stale.
   */
  private backfillReferenceDataOrder(): void {
    let changed = false;
    for (const records of [this.db.systems, this.db.locations]) {
      const categories = new Set(records.map((record) => record.category));
      for (const category of categories) {
        const inCategory = records.filter((record) => record.category === category);
        const allOrdersValid = inCategory.every(
          (record) => Number.isInteger(record.displayOrder) && record.displayOrder > 0,
        );
        const ordered = [...inCategory].sort(
          allOrdersValid
            ? compareReferenceRecords
            : (a, b) =>
                normalizedReferenceName(a.name).localeCompare(normalizedReferenceName(b.name), 'he') ||
                a.id.localeCompare(b.id),
        );
        if (ordered.some((record, index) => record.displayOrder !== index + 1)) {
          ordered.forEach((record, index) => {
            record.displayOrder = index + 1;
          });
          changed = true;
        }
      }
    }
    if (changed) {
      this.db.referenceDataSchemaVersion = 1;
      this.persist();
    }
  }

  /**
   * Demo databases persisted before fixed categories existed have no
   * `category` field. Backfill them in place to 'other' -- exactly the same
   * data transition migration 0041 applies to pre-existing hosted rows. No
   * record is removed, renamed, reordered across categories, or reactivated.
   */
  private backfillReferenceDataCategory(): void {
    if (this.db.referenceDataSchemaVersion === 2) return;
    for (const record of this.db.systems) {
      if (!record.category) record.category = 'other';
    }
    for (const record of this.db.locations) {
      if (!record.category) record.category = 'other';
    }
    this.db.referenceDataSchemaVersion = 2;
    this.persist();
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
    // Actor snapshot, mirroring write_audit()'s server-side behavior: the
    // display name is captured at write time from the acting profile,
    // independent of a later rename. Email has no demo-mode equivalent
    // (there is no auth.users here), so it stays null -- "where available"
    // per the audit data model, and it is genuinely not available here.
    const actorDisplayName = actorId ? (this.db.profiles.find((p) => p.id === actorId)?.fullName ?? null) : null;
    this.db.auditLogs.push({
      id: newId(),
      actorId,
      actorDisplayName,
      actorEmail: null,
      action,
      entityType,
      entityId,
      entityLabel: null,
      summary: null,
      incidentNumber: null,
      before: null,
      after: null,
      metadata: null,
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
      userNote: null,
      refId: null,
      createdAt: ts,
      operationId: null,
      ...extra,
    };
    this.db.incidentEvents.push(event);
    return event;
  }

  private notify(
    userId: string,
    type: AppNotification['type'],
    category: AppNotification['category'],
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
      category,
      incidentId: opts.incidentId ?? null,
      handoverId: opts.handoverId ?? null,
      text,
      read: false,
      createdAt: this.now().toISOString(),
      dedupeKey: opts.dedupeKey,
      dismissedAt: null,
    });
  }

  /**
   * Role-based operational broadcast: every active professional_manager
   * (unconditionally), PLUS every active system_admin who has personally
   * opted in (operationalNotificationsEnabled) -- except the acting user
   * and anyone in excludeUserIds (used to skip a recipient who already got
   * a personal, action_required notification for this exact operation --
   * e.g. the professional_manager or opted-in system_admin who becomes the
   * incident's owner during create/reopen; see the product's dedup rule).
   * Always category 'update'. Mirrors notify_operational_recipients()
   * (migrations 0043/0044): recipients are derived from active profiles
   * server-side (here, in-process) -- never client-supplied. Every other
   * role is never a recipient, even if operationalNotificationsEnabled
   * were somehow true on its row.
   */
  private notifyOperationalRecipients(
    actorId: string,
    type: AppNotification['type'],
    text: string,
    opts: { incidentId: string; operationId: string; excludeUserIds?: string[] },
  ): void {
    const exclude = new Set([actorId, ...(opts.excludeUserIds ?? [])]);
    for (const profile of this.db.profiles) {
      const eligible =
        profile.role === 'professional_manager' ||
        (profile.role === 'system_admin' && profile.operationalNotificationsEnabled);
      if (!eligible || !profile.active) continue;
      if (exclude.has(profile.id)) continue;
      this.notify(profile.id, type, 'update', text, {
        incidentId: opts.incidentId,
        dedupeKey: `opn-${opts.operationId}-${profile.id}`,
      });
    }
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

  /** Defense-in-depth mirror of migration 0032's RPC guard (and CHECK
   *  constraint): checked against the MERGED post-preserve/update/clear
   *  values, not the raw payload -- catches the same "contact with no name"
   *  state the schema's lenient update-family check must let through when
   *  the name key was merely omitted (see checkExternalHandlerNameRequiredOnSupply
   *  in schemas.ts). */
  private assertExternalHandlerValid(name: string | null, contactPerson: string | null, contactDetails: string | null): void {
    if (!name && (contactPerson || contactDetails)) {
      throw new AppError('VALIDATION', 'יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר');
    }
  }

  /** Mirrors update_incident's/technician_update_incident's own event-time
   *  bounds check (migration 0020): rejects an unparseable eventTime, or one
   *  outside [discoveredAt, now + 5 minutes]. Schema-level required-ness
   *  (non-empty string) is already enforced by parseOrThrow before this
   *  runs -- this only covers what Zod's plain string type cannot: parse
   *  validity and the incident-relative bounds. */
  private validateEventTime(incident: Incident, eventTime: string): void {
    const t = new Date(eventTime).getTime();
    if (
      Number.isNaN(t) ||
      t < new Date(incident.discoveredAt).getTime() ||
      t > this.now().getTime() + 5 * 60_000
    ) {
      throw new AppError('VALIDATION', 'מועד העדכון בפועל אינו תקין.');
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
    return [...this.db.systems]
      .sort(compareReferenceRecordsForListing(SYSTEM_CATEGORY_ORDER))
      .map((record) => ({ ...record }));
  }

  async listLocations(): Promise<LocationRecord[]> {
    return [...this.db.locations]
      .sort(compareReferenceRecordsForListing(LOCATION_CATEGORY_ORDER))
      .map((record) => ({ ...record }));
  }

  private requireName(name: string): string {
    if (typeof name !== 'string') throw new AppError('VALIDATION', 'יש להזין שם.');
    const trimmed = name.trim();
    if (!trimmed) throw new AppError('VALIDATION', 'יש להזין שם.');
    if (trimmed.length > 120) throw new AppError('VALIDATION', 'שם ארוך מדי (עד 120 תווים).');
    return trimmed;
  }

  private requireAvailableName(
    records: ReferenceRecord[],
    name: string,
    conflictMessage: string,
    excludedId?: string,
  ): void {
    const normalized = normalizedReferenceName(name);
    if (records.some((record) => record.id !== excludedId && normalizedReferenceName(record.name) === normalized)) {
      throw new AppError('CONFLICT', conflictMessage);
    }
  }

  private moveReferenceData<T extends ReferenceRecord>(
    records: T[],
    id: string,
    direction: ReferenceDataMoveDirection,
    actorId: string,
    entityType: 'system' | 'location',
    notFoundMessage: string,
  ): void {
    if (direction !== 'up' && direction !== 'down') {
      throw new AppError('VALIDATION', 'כיוון ההזזה אינו תקין.');
    }
    const target = records.find((record) => record.id === id);
    if (!target) throw new AppError('NOT_FOUND', notFoundMessage);

    // Scoped to the target's own category: neighbor lookup and gap
    // canonicalization never touch another category's records.
    const sameCategory = records.filter((record) => record.category === target.category);
    const ordered = [...sameCategory].sort(compareReferenceRecords);
    const recordIndex = ordered.findIndex((record) => record.id === id);

    // Canonicalize first so legacy equal/gapped order values cannot make a
    // move ambiguous. The secondary name/id ordering above is deterministic.
    ordered.forEach((record, index) => {
      record.displayOrder = index + 1;
    });

    const targetIndex = direction === 'up' ? recordIndex - 1 : recordIndex + 1;
    const neighbor = ordered[targetIndex];
    if (!neighbor) {
      this.persist();
      return;
    }

    const record = ordered[recordIndex];
    const before = record.displayOrder;
    record.displayOrder = neighbor.displayOrder;
    neighbor.displayOrder = before;
    this.audit(actorId, `${entityType}_moved`, entityType, id, {
      before: JSON.stringify({ displayOrder: before }),
      after: JSON.stringify({ displayOrder: record.displayOrder }),
    });
    this.persist();
  }

  /**
   * Batch reorder mirroring the reorder_systems/reorder_locations RPCs
   * (migration 0041): orderedIds must be exactly the full, duplicate-free
   * set of ids of ONE category (never spanning more than one -- that is
   * also what stops this from being used to smuggle a category change), in
   * their new order. Rejects anything malformed before touching any
   * displayOrder, so a rejected attempt never leaves a partial reorder
   * behind, and never touches another category's records.
   */
  private reorderReferenceData<T extends ReferenceRecord>(
    records: T[],
    orderedIds: string[],
    actorId: string,
    entityType: 'system' | 'location',
  ): void {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      throw new AppError('VALIDATION', 'יש לספק רשימת מזהים לסידור.');
    }
    const uniqueIds = new Set(orderedIds);
    if (uniqueIds.size !== orderedIds.length) {
      throw new AppError('VALIDATION', 'רשימת הסידור מכילה מזהים כפולים.');
    }
    const mismatchMessage =
      entityType === 'system'
        ? 'רשימת הסידור אינה תואמת את המערכות / העמדות הקיימות.'
        : 'רשימת הסידור אינה תואמת את המיקומים הקיימים.';
    const category = records.find((record) => record.id === orderedIds[0])?.category;
    if (!category) throw new AppError('VALIDATION', mismatchMessage);
    const categoryRecords = records.filter((record) => record.category === category);
    const categoryIds = new Set(categoryRecords.map((record) => record.id));
    if (uniqueIds.size !== categoryIds.size || orderedIds.some((id) => !categoryIds.has(id))) {
      throw new AppError('VALIDATION', mismatchMessage);
    }

    orderedIds.forEach((id, index) => {
      const record = records.find((r) => r.id === id)!;
      record.displayOrder = index + 1;
    });
    this.audit(actorId, `${entityType}s_reordered`, entityType, 'bulk', {
      after: JSON.stringify({ order: orderedIds }),
    });
    this.persist();
  }

  private requireSystemCategory(category: unknown): SystemCategory {
    if (typeof category !== 'string' || !SYSTEM_CATEGORY_ORDER.includes(category as SystemCategory)) {
      throw new AppError('VALIDATION', 'סוג מערכת / עמדה אינו תקין.');
    }
    return category as SystemCategory;
  }

  private requireLocationCategory(category: unknown): LocationCategory {
    if (typeof category !== 'string' || !LOCATION_CATEGORY_ORDER.includes(category as LocationCategory)) {
      throw new AppError('VALIDATION', 'סוג מיקום אינו תקין.');
    }
    return category as LocationCategory;
  }

  async createSystem(session: Session, name: string, category: SystemCategory): Promise<SystemRecord> {
    const actor = this.requireCap(session, 'manage_config');
    const validName = this.requireName(name);
    const validCategory = this.requireSystemCategory(category);
    this.requireAvailableName(this.db.systems, validName, SYSTEM_NAME_CONFLICT_MSG);
    const record: SystemRecord = {
      id: newId(),
      name: validName,
      archived: false,
      category: validCategory,
      displayOrder:
        Math.max(0, ...this.db.systems.filter((item) => item.category === validCategory).map((item) => item.displayOrder)) +
        1,
      createdAt: this.now().toISOString(),
    };
    this.db.systems.push(record);
    this.audit(actor.id, 'system_created', 'system', record.id, {
      after: JSON.stringify(record),
      entityLabel: record.name,
    });
    this.persist();
    return record;
  }

  async renameSystem(session: Session, id: string, name: string): Promise<void> {
    const actor = this.requireCap(session, 'manage_config');
    const record = this.db.systems.find((s) => s.id === id);
    if (!record) throw new AppError('NOT_FOUND', 'המערכת לא נמצאה.');
    const validName = this.requireName(name);
    this.requireAvailableName(this.db.systems, validName, SYSTEM_NAME_CONFLICT_MSG, id);
    if (record.name === validName) return;
    const before = record.name;
    record.name = validName;
    this.audit(actor.id, 'system_renamed', 'system', id, {
      before: JSON.stringify({ name: before }),
      after: JSON.stringify({ name: record.name }),
      entityLabel: record.name,
    });
    this.persist();
  }

  async setSystemArchived(session: Session, id: string, archived: boolean): Promise<void> {
    const actor = this.requireCap(session, 'manage_config');
    const record = this.db.systems.find((s) => s.id === id);
    if (!record) throw new AppError('NOT_FOUND', 'המערכת לא נמצאה.');
    if (record.archived && !archived) {
      this.requireAvailableName(this.db.systems, record.name, SYSTEM_NAME_CONFLICT_MSG, id);
    }
    if (record.archived === archived) return;
    record.archived = archived;
    this.audit(actor.id, archived ? 'system_archived' : 'system_restored', 'system', id, {
      before: JSON.stringify({ archived: !archived }),
      after: JSON.stringify({ archived }),
      entityLabel: record.name,
    });
    this.persist();
  }

  async moveSystem(session: Session, id: string, direction: ReferenceDataMoveDirection): Promise<void> {
    const actor = this.requireCap(session, 'manage_config');
    this.moveReferenceData(this.db.systems, id, direction, actor.id, 'system', 'המערכת לא נמצאה.');
  }

  async reorderSystems(session: Session, orderedIds: string[]): Promise<void> {
    const actor = this.requireCap(session, 'manage_config');
    this.reorderReferenceData(this.db.systems, orderedIds, actor.id, 'system');
  }

  async setSystemCategory(session: Session, id: string, category: SystemCategory): Promise<void> {
    const actor = this.requireCap(session, 'manage_config');
    const record = this.db.systems.find((s) => s.id === id);
    if (!record) throw new AppError('NOT_FOUND', 'המערכת לא נמצאה.');
    const validCategory = this.requireSystemCategory(category);
    if (record.category === validCategory) return;
    const before = record.category;
    record.category = validCategory;
    record.displayOrder =
      Math.max(0, ...this.db.systems.filter((item) => item.category === validCategory && item.id !== id).map((item) => item.displayOrder)) +
      1;
    // Close the gap left in the source category so its remaining records
    // keep a contiguous, deterministic order -- mirrors set_system_category
    // (migration 0041). Never touches the destination category.
    [...this.db.systems]
      .filter((system) => system.category === before)
      .sort(compareReferenceRecords)
      .forEach((system, position) => {
        system.displayOrder = position + 1;
      });
    this.audit(actor.id, 'system_category_changed', 'system', id, {
      before: JSON.stringify({ category: before }),
      after: JSON.stringify({ category: record.category }),
    });
    this.persist();
  }

  async deleteSystem(session: Session, id: string): Promise<ReferenceDataDeleteOutcome> {
    const actor = this.requireCap(session, 'manage_config');
    const index = this.db.systems.findIndex((system) => system.id === id);
    if (index === -1) throw new AppError('NOT_FOUND', 'המערכת לא נמצאה.');
    const record = this.db.systems[index];
    if (this.db.incidents.some((incident) => incident.systemId === id)) {
      const wasArchived = record.archived;
      record.archived = true;
      this.audit(actor.id, 'system_delete_archived', 'system', id, {
        before: JSON.stringify({ archived: wasArchived }),
        after: JSON.stringify({ archived: true }),
        entityLabel: record.name,
      });
      this.persist();
      return 'archived';
    }
    this.db.systems.splice(index, 1);
    [...this.db.systems]
      .filter((system) => system.category === record.category)
      .sort(compareReferenceRecords)
      .forEach((system, position) => {
        system.displayOrder = position + 1;
      });
    this.audit(actor.id, 'system_deleted', 'system', id, {
      before: JSON.stringify(record),
      entityLabel: record.name,
    });
    this.persist();
    return 'deleted';
  }

  async createLocation(session: Session, name: string, category: LocationCategory): Promise<LocationRecord> {
    const actor = this.requireCap(session, 'manage_config');
    const validName = this.requireName(name);
    const validCategory = this.requireLocationCategory(category);
    this.requireAvailableName(this.db.locations, validName, LOCATION_NAME_CONFLICT_MSG);
    const record: LocationRecord = {
      id: newId(),
      name: validName,
      archived: false,
      category: validCategory,
      displayOrder:
        Math.max(
          0,
          ...this.db.locations.filter((item) => item.category === validCategory).map((item) => item.displayOrder),
        ) + 1,
      createdAt: this.now().toISOString(),
    };
    this.db.locations.push(record);
    this.audit(actor.id, 'location_created', 'location', record.id, {
      after: JSON.stringify(record),
      entityLabel: record.name,
    });
    this.persist();
    return record;
  }

  async renameLocation(session: Session, id: string, name: string): Promise<void> {
    const actor = this.requireCap(session, 'manage_config');
    const record = this.db.locations.find((l) => l.id === id);
    if (!record) throw new AppError('NOT_FOUND', 'המיקום לא נמצא.');
    const validName = this.requireName(name);
    this.requireAvailableName(this.db.locations, validName, LOCATION_NAME_CONFLICT_MSG, id);
    if (record.name === validName) return;
    const before = record.name;
    record.name = validName;
    this.audit(actor.id, 'location_renamed', 'location', id, {
      before: JSON.stringify({ name: before }),
      after: JSON.stringify({ name: record.name }),
      entityLabel: record.name,
    });
    this.persist();
  }

  async setLocationArchived(session: Session, id: string, archived: boolean): Promise<void> {
    const actor = this.requireCap(session, 'manage_config');
    const record = this.db.locations.find((l) => l.id === id);
    if (!record) throw new AppError('NOT_FOUND', 'המיקום לא נמצא.');
    if (record.archived && !archived) {
      this.requireAvailableName(this.db.locations, record.name, LOCATION_NAME_CONFLICT_MSG, id);
    }
    if (record.archived === archived) return;
    record.archived = archived;
    this.audit(actor.id, archived ? 'location_archived' : 'location_restored', 'location', id, {
      before: JSON.stringify({ archived: !archived }),
      after: JSON.stringify({ archived }),
      entityLabel: record.name,
    });
    this.persist();
  }

  async moveLocation(session: Session, id: string, direction: ReferenceDataMoveDirection): Promise<void> {
    const actor = this.requireCap(session, 'manage_config');
    this.moveReferenceData(this.db.locations, id, direction, actor.id, 'location', 'המיקום לא נמצא.');
  }

  async reorderLocations(session: Session, orderedIds: string[]): Promise<void> {
    const actor = this.requireCap(session, 'manage_config');
    this.reorderReferenceData(this.db.locations, orderedIds, actor.id, 'location');
  }

  async setLocationCategory(session: Session, id: string, category: LocationCategory): Promise<void> {
    const actor = this.requireCap(session, 'manage_config');
    const record = this.db.locations.find((l) => l.id === id);
    if (!record) throw new AppError('NOT_FOUND', 'המיקום לא נמצא.');
    const validCategory = this.requireLocationCategory(category);
    if (record.category === validCategory) return;
    const before = record.category;
    record.category = validCategory;
    record.displayOrder =
      Math.max(
        0,
        ...this.db.locations
          .filter((item) => item.category === validCategory && item.id !== id)
          .map((item) => item.displayOrder),
      ) + 1;
    // Close the gap left in the source category -- mirrors
    // set_location_category (migration 0041). Never touches the
    // destination category.
    [...this.db.locations]
      .filter((location) => location.category === before)
      .sort(compareReferenceRecords)
      .forEach((location, position) => {
        location.displayOrder = position + 1;
      });
    this.audit(actor.id, 'location_category_changed', 'location', id, {
      before: JSON.stringify({ category: before }),
      after: JSON.stringify({ category: record.category }),
    });
    this.persist();
  }

  async deleteLocation(session: Session, id: string): Promise<ReferenceDataDeleteOutcome> {
    const actor = this.requireCap(session, 'manage_config');
    const index = this.db.locations.findIndex((location) => location.id === id);
    if (index === -1) throw new AppError('NOT_FOUND', 'המיקום לא נמצא.');
    const record = this.db.locations[index];
    if (this.db.incidents.some((incident) => incident.locationId === id)) {
      const wasArchived = record.archived;
      record.archived = true;
      this.audit(actor.id, 'location_delete_archived', 'location', id, {
        before: JSON.stringify({ archived: wasArchived }),
        after: JSON.stringify({ archived: true }),
        entityLabel: record.name,
      });
      this.persist();
      return 'archived';
    }
    this.db.locations.splice(index, 1);
    [...this.db.locations]
      .filter((location) => location.category === record.category)
      .sort(compareReferenceRecords)
      .forEach((location, position) => {
        location.displayOrder = position + 1;
      });
    this.audit(actor.id, 'location_deleted', 'location', id, {
      before: JSON.stringify(record),
      entityLabel: record.name,
    });
    this.persist();
    return 'deleted';
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
      entityLabel: profile.fullName,
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
    const wasActive = profile.active;
    profile.active = active;
    this.audit(actor.id, active ? 'user_activated' : 'user_deactivated', 'profile', userId, {
      before: JSON.stringify({ active: wasActive }),
      after: JSON.stringify({ active }),
      entityLabel: profile.fullName,
    });
    this.persist();
  }

  async renameLinkedPersonnel(session: Session, userId: string, rawInput: RenamePersonnelInput): Promise<void> {
    // requirePersonnelManager already restricts the caller to the three
    // personnel-manager roles -- shift_supervisor / professional_manager /
    // system_admin -- so a technician or viewer never reaches this method
    // at all, including to rename themselves.
    const actor = this.requirePersonnelManager(session);
    const input = parseOrThrow(renamePersonnelInputSchema, rawInput);
    const isSelf = userId === actor.id;
    const profile = this.db.profiles.find((p) => p.id === userId);
    if (!profile) throw new AppError('NOT_FOUND', 'המשתמש לא נמצא.');
    // Mirrors migration 0034: a tombstoned profile's name is permanent
    // historical record, not an editable field.
    if (profile.deletedAt) {
      throw new AppError('VALIDATION', 'לא ניתן לשנות שם למשתמש שנמחק.');
    }
    // Self-service rename: deliberately NOT allowedManageRoles(actor.role)
    // -- that ceiling governs managing OTHER people and excludes a
    // caller's own peer rank (e.g. a professional_manager may not manage
    // another professional_manager), which would wrongly block a
    // professional_manager or shift_supervisor from renaming themselves.
    // Renaming someone ELSE keeps the existing ceiling unchanged.
    if (!isSelf && !allowedManageRoles(actor.role).includes(profile.role)) {
      throw new AppError('FORBIDDEN', 'אין הרשאה לנהל משתמש בתפקיד זה.');
    }
    const before = profile.fullName;
    profile.fullName = input.fullName;
    this.audit(actor.id, 'user_renamed', 'profile', userId, {
      before: JSON.stringify({ fullName: before }),
      after: JSON.stringify({ fullName: profile.fullName }),
      entityLabel: profile.fullName,
    });
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
    this.audit(actor.id, 'user_tombstoned', 'profile', userId, {
      before: JSON.stringify({ active: true }),
      after: JSON.stringify({ active: false, deleted: true }),
      entityLabel: profile.fullName,
    });
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

  private causeAssessmentRows(): IncidentCauseAssessment[] {
    if (!this.db.incidentCauseAssessments) this.db.incidentCauseAssessments = [];
    return this.db.incidentCauseAssessments;
  }

  private treatmentActionRows(): IncidentTreatmentAction[] {
    if (!this.db.incidentTreatmentActions) this.db.incidentTreatmentActions = [];
    return this.db.incidentTreatmentActions;
  }

  private closureRows(): IncidentClosureClassification[] {
    if (!this.db.incidentClosures) this.db.incidentClosures = [];
    return this.db.incidentClosures;
  }

  private relationRows(): StoredIncidentRelation[] {
    if (!this.db.incidentRelations) this.db.incidentRelations = [];
    return this.db.incidentRelations;
  }

  private incidentSummary(incident: Incident): IncidentSummary {
    return {
      id: incident.id,
      number: incident.number,
      severity: incident.severity,
      status: incident.status,
      systemId: incident.systemId,
      locationId: incident.locationId,
      description: incident.description,
    };
  }

  /** Records one current-suspected-cause history row -- mirrors
   *  update_incident/technician_update_incident/create_incident_impl's own
   *  insert into incident_cause_assessments (migration 0047) exactly. */
  private recordCauseAssessment(
    incidentId: string,
    cause: SuspectedCause,
    otherDetail: string | null,
    cycleNumber: number,
    recordedBy: string,
    eventTime: string | null,
    operationId: string | null,
  ): void {
    const ts = this.now().toISOString();
    this.causeAssessmentRows().push({
      id: newId(),
      incidentId,
      cause,
      otherDetail: cause === 'other' ? otherDetail : null,
      cycleNumber,
      recordedBy,
      eventTime,
      recordedAt: ts,
      operationId,
      createdAt: ts,
    });
  }

  /** Inserts one row per DISTINCT (actionType, otherDetail) entry in
   *  `actions` -- mirrors every RPC's own within-one-array de-duplication
   *  exactly (migration 0047): an accidental duplicate chip within the
   *  SAME submitted array is silently collapsed to one row; the same
   *  action type recorded again in a later, separate operation remains a
   *  normal, distinct row. Returns the ids of the rows actually inserted,
   *  in submission order (deduped), for closure's inline-quick-add
   *  linking. */
  private insertTreatmentActions(
    incidentId: string,
    actions: TreatmentActionInput[],
    cycleNumber: number,
    eventTime: string | null,
    recordedBy: string,
    operationId: string | null,
  ): string[] {
    const rows = this.treatmentActionRows();
    const ts = this.now().toISOString();
    const seen = new Set<string>();
    const insertedIds: string[] = [];
    for (const action of actions) {
      const otherDetail = action.actionType === 'other' ? (action.otherDetail ?? '').trim() || null : null;
      const key = `${action.actionType}|${otherDetail ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const id = newId();
      rows.push({
        id,
        incidentId,
        actionType: action.actionType,
        otherDetail,
        cycleNumber,
        eventTime,
        recordedBy,
        recordedAt: ts,
        operationId,
        createdAt: ts,
      });
      insertedIds.push(id);
    }
    return insertedIds;
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
        avatarUrl: null,
      }));
    const linked: PersonnelEntry[] = this.db.profiles.map((p) => ({
      kind: 'linked' as const,
      id: p.id,
      fullName: p.fullName,
      email: this.linkedEmailOf(p.id),
      role: p.role,
      state: p.deletedAt ? ('deleted' as const) : p.active ? ('active' as const) : ('inactive' as const),
      createdAt: p.createdAt,
      avatarUrl: p.avatarUrl ?? null,
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

  async renamePendingPersonnel(session: Session, id: string, rawInput: RenamePersonnelInput): Promise<PendingPersonnel> {
    const actor = this.requirePersonnelManager(session);
    const input = parseOrThrow(renamePersonnelInputSchema, rawInput);
    const row = this.pendingRows().find((r) => r.id === id);
    if (!row) throw new AppError('NOT_FOUND', 'הרישום לא נמצא.');
    if (row.status !== 'pending') throw new AppError('VALIDATION', 'ניתן לשנות שם רק לרישום ממתין.');
    if (!allowedAssignRoles(actor.role).includes(row.role)) {
      throw new AppError('FORBIDDEN', 'אין הרשאה לשנות את שמו של רישום זה.');
    }
    const before = row.fullName;
    row.fullName = input.fullName;
    row.updatedAt = this.now().toISOString();
    this.audit(actor.id, 'personnel_pending_renamed', 'pending_personnel', row.id, {
      before: JSON.stringify({ fullName: before }),
      after: JSON.stringify({ fullName: row.fullName }),
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

  async setOwnAvatarUrl(_avatarUrl: string | null): Promise<void> {
    // Demo mode has no OAuth session and therefore no provider image to
    // persist -- AuthContext's DemoAuthProvider never calls this method.
  }

  /**
   * Self-only opt-in/out of role-based operational notifications. Mirrors
   * set_my_operational_notifications_enabled(): the target is always the
   * CALLER's own profile (session.userId), never a client-supplied id;
   * restricted to an active system_admin.
   */
  async setMyOperationalNotificationsEnabled(session: Session, enabled: boolean): Promise<Profile> {
    const actor = this.requireSession(session);
    if (actor.role !== 'system_admin') {
      throw new AppError('FORBIDDEN', 'ההעדפה זמינה למנהלי מערכת בלבד.');
    }
    actor.operationalNotificationsEnabled = enabled;
    this.persist();
    return { ...actor };
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
      operationalNotificationsEnabled: false,
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
        return sortByPriority(rows);
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

  async countClosedIncidents(session: Session): Promise<number> {
    // Same contract as the Supabase implementation: literally status ===
    // 'closed', counted over every incident (never the truncated/sorted list
    // a view happens to be showing), and never including 'cancelled'.
    this.requireCap(session, 'view_all_incidents');
    return this.db.incidents.filter((i) => i.status === 'closed').length;
  }

  async getIncidentAnalytics(session: Session, filters: AnalyticsFilters): Promise<IncidentAnalytics> {
    this.requireCap(session, 'view_all_incidents');
    return computeIncidentAnalytics(
      this.db.incidents,
      this.db.incidentEvents,
      this.db.systems,
      this.db.locations,
      filters,
      this.now(),
    );
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

  async getIncidentCauseAssessments(session: Session, incidentId: string): Promise<IncidentCauseAssessment[]> {
    this.requireCap(session, 'view_all_incidents');
    // Sorted by recordedAt (always populated), not eventTime (nullable for
    // the initial creation-time assessment) -- see the type's own comment.
    return this.causeAssessmentRows()
      .filter((a) => a.incidentId === incidentId)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
      .map((a) => ({ ...a }));
  }

  async getIncidentTreatmentActions(session: Session, incidentId: string): Promise<IncidentTreatmentAction[]> {
    this.requireCap(session, 'view_all_incidents');
    return this.treatmentActionRows()
      .filter((a) => a.incidentId === incidentId)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
      .map((a) => ({ ...a }));
  }

  async getIncidentClosures(session: Session, incidentId: string): Promise<IncidentClosureClassification[]> {
    this.requireCap(session, 'view_all_incidents');
    return this.closureRows()
      .filter((c) => c.incidentId === incidentId)
      .sort((a, b) => a.eventTime.localeCompare(b.eventTime))
      .map((c) => ({ ...c, resolutionActionIds: [...c.resolutionActionIds] }));
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
      // ownerUserId is mandatory and ownerExternalName is rejected outright
      // when non-blank (createIncidentSchema's own superRefine, mirroring
      // create_incident's migration-0019 database check) -- by the time
      // parseOrThrow above has returned, ownerExternalName is guaranteed
      // blank here.
      ownerUserId: input.ownerUserId,
      ownerExternalName: null,
      externalHandlerName: (input.externalHandlerName ?? '').trim() || null,
      externalHandlerContactPerson: (input.externalHandlerContactPerson ?? '').trim() || null,
      externalHandlerContactDetails: (input.externalHandlerContactDetails ?? '').trim() || null,
      discoveredAt: input.discoveredAt,
      createdAt: ts,
      createdBy: actor.id,
      updatedAt: ts,
      updatedBy: actor.id,
      lastUpdateAt: ts,
      // The next-update-ETA concept is no longer an active question this
      // form asks -- every new incident stores both as NULL. The columns
      // themselves stay in the schema for historical incidents and for
      // reopen_incident's own still-independent (and still optional) field.
      nextUpdateDue: null,
      noDeadlineReason: null,
      reportedToOps: input.reportedToOps,
      reportedToOpsRecipient:
        input.reportedToOps === 'yes' ? (input.reportedToOpsRecipient ?? '').trim() || null : null,
      // Opening-time-only questions (migration 0021 parity): createIncidentSchema's
      // own superRefine already guarantees the dependent value is present and
      // non-blank whenever its flag is true (same enforcement point as
      // ownerUserId/eventTime elsewhere in this repository -- parseOrThrow
      // above runs even for a caller that bypasses the UI entirely) -- trimmed
      // here the same way reportedToOpsRecipient is, and forced to null
      // whenever the flag is false so stale hidden data is never retained.
      reportedToComms: input.reportedToComms,
      reportedToCommsRecipient:
        input.reportedToComms ? (input.reportedToCommsRecipient ?? '').trim() || null : null,
      wisdomReported: input.wisdomReported,
      wisdomIncidentNumber: input.wisdomReported ? (input.wisdomIncidentNumber ?? '').trim() || null : null,
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
      // תחום התקלה -- required by createIncidentSchema, so always present
      // here. Optional initial suspected cause becomes the incident's
      // first current assessment when supplied; stays NULL ("never
      // assessed") when omitted, never defaulted to the explicit
      // 'unknown' enum value.
      reportedDomain: input.reportedDomain,
      currentSuspectedCause: input.initialSuspectedCause ?? null,
      currentSuspectedCauseOtherDetail:
        input.initialSuspectedCause === 'other' ? (input.initialSuspectedCauseOtherDetail ?? '').trim() || null : null,
    };
    this.db.incidents.push(incident);

    // The two new answers are folded into the SAME 'created' event's note
    // (never a separate event type, mirroring migration 0021 exactly): they
    // are set exactly once, at open, and never revised by any later flow in
    // this PR.
    const commsLine = incident.reportedToComms
      ? `כן (דווח ל: ${incident.reportedToCommsRecipient})`
      : 'לא';
    const wisdomLine = incident.wisdomReported
      ? `כן (מספר תקלה: ${incident.wisdomIncidentNumber})`
      : 'לא';
    const operationId = newId();
    this.addEvent(incident.id, 'created', actor.id, {
      eventTime: input.discoveredAt,
      operationId,
      note:
        `פעולות שבוצעו עד כה: ${input.actionsTaken.trim()}\n` +
        `תקשוב למבצעים: ${commsLine}\n` +
        `WISDOM: ${wisdomLine}`,
      // "הערה נוספת": a separate, optional, raw user note -- never folded
      // into the generated note above. Blank/whitespace-only -> null.
      userNote: (input.note ?? '').trim() || null,
    });
    if (incident.reportedToOps === 'yes' && incident.reportedToOpsRecipient) {
      this.addEvent(incident.id, 'reported_to_ops_change', actor.id, {
        field: 'reported_to_ops_recipient',
        newValue: incident.reportedToOpsRecipient,
        note: `דווח למבצעים: ${incident.reportedToOpsRecipient}`,
        eventTime: input.discoveredAt,
        operationId,
      });
    }
    if (input.status !== 'new') {
      this.addEvent(incident.id, 'status_change', actor.id, {
        field: 'status',
        oldValue: 'new',
        newValue: input.status,
        eventTime: input.discoveredAt,
        operationId,
      });
    }

    // Initial suspected-cause history row -- no dedicated
    // 'cause_assessment_changed' event is written for this one: that
    // event type carries a real effective event_time, and the initial
    // assessment has none. The Timeline instead renders it inline on this
    // 'created' card by joining on operationId.
    if (incident.currentSuspectedCause) {
      this.recordCauseAssessment(
        incident.id,
        incident.currentSuspectedCause,
        incident.currentSuspectedCauseOtherDetail,
        0,
        actor.id,
        null,
        operationId,
      );
    }
    // Optional initial treatment actions -- same NULL-event_time
    // reasoning: no real time is ever collected for these ("already
    // performed before the incident was opened").
    this.insertTreatmentActions(incident.id, input.initialTreatmentActions, 0, null, actor.id, operationId);

    this.audit(actor.id, 'incident_created', 'incident', incident.id, {
      incidentNumber: incident.number,
      after: JSON.stringify({ number: incident.number, severity: incident.severity, status: incident.status }),
      entityLabel: incident.number,
    });

    if (incident.ownerUserId && incident.ownerUserId !== actor.id) {
      this.notify(incident.ownerUserId, 'incident_assigned', 'action_required', `תקלה ${incident.number} הוקצתה אליך.`, {
        incidentId: incident.id,
        dedupeKey: `assign-${incident.id}-create`,
      });
    }
    this.notifyOperationalRecipients(
      actor.id,
      'incident_opened',
      `נפתחה תקלה ${incident.number} · ${system.name} · ${location.name}`,
      {
        incidentId: incident.id,
        operationId,
        excludeUserIds: incident.ownerUserId ? [incident.ownerUserId] : [],
      },
    );
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
    this.addEvent(incidentId, 'acknowledged', actor.id, { operationId: newId() });
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
    this.validateEventTime(incident, input.eventTime);
    this.validateOwner(input.ownerUserId);

    // Compute the merged external-handler values and validate them BEFORE
    // any mutation or side effect (incidentUpdates.push, addEvent, audit,
    // notify, incident field mutation) -- a rejected external-handler
    // payload must leave the incident, its updates, events, audits, and
    // notifications byte-for-byte unchanged.
    const oldExtName = incident.externalHandlerName;
    const oldExtPerson = incident.externalHandlerContactPerson;
    const oldExtDetails = incident.externalHandlerContactDetails;
    const newExtName = input.externalHandlerName !== undefined
      ? (input.externalHandlerName ?? '').trim() || null
      : oldExtName;
    const newExtPerson = input.externalHandlerContactPerson !== undefined
      ? (input.externalHandlerContactPerson ?? '').trim() || null
      : oldExtPerson;
    const newExtDetails = input.externalHandlerContactDetails !== undefined
      ? (input.externalHandlerContactDetails ?? '').trim() || null
      : oldExtDetails;
    this.assertExternalHandlerValid(newExtName, newExtPerson, newExtDetails);

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
      currentStatusText: input.currentStatusText.trim() || null,
      // Update-specific reporting: fresh answers about THIS update only --
      // never derived from or written back onto the incident's own
      // opening-time reportedToOps/reportedToComms/wisdomReported facts.
      updateReportedToOps: input.updateReportedToOps === '' ? null : input.updateReportedToOps,
      updateReportedToOpsRecipient:
        input.updateReportedToOps === 'yes' ? (input.updateReportedToOpsRecipient ?? '').trim() || null : null,
      updateReportedToComms: input.updateReportedToComms === '' ? null : input.updateReportedToComms === 'yes',
      updateReportedToCommsRecipient:
        input.updateReportedToComms === 'yes' ? (input.updateReportedToCommsRecipient ?? '').trim() || null : null,
      updateWisdomReported: input.updateWisdomReported === '' ? null : input.updateWisdomReported === 'yes',
      // "הערה נוספת": a separate, optional, raw user note on THIS update
      // only -- never folded into actionsTaken/findings/nextSteps/
      // currentStatusText. Blank/whitespace-only -> null.
      userNote: (input.note ?? '').trim() || null,
      createdAt: ts,
    };
    this.db.incidentUpdates.push(update);
    const operationId = newId();
    this.addEvent(incidentId, 'update', actor.id, {
      eventTime: input.eventTime,
      refId: update.id,
      operationId,
    });

    // Protected-field diffs → dedicated events. Each shares the update's own
    // operationId and its user-selected eventTime -- mirroring update_incident
    // (migration 0026): only the 'update' row itself used to carry the actual
    // event time, leaving these silently stamped with "now" instead.
    if (input.status !== incident.status) {
      this.addEvent(incidentId, 'status_change', actor.id, {
        field: 'status',
        oldValue: incident.status,
        newValue: input.status,
        note: input.changeReason.trim() || null,
        eventTime: input.eventTime,
        operationId,
      });
      this.audit(actor.id, 'incident_status_changed', 'incident', incidentId, {
        incidentNumber: incident.number,
        before: JSON.stringify({ status: incident.status }),
        after: JSON.stringify({ status: input.status }),
        entityLabel: incident.number,
      });
    }
    if (input.severity !== incident.severity) {
      this.addEvent(incidentId, 'severity_change', actor.id, {
        field: 'severity',
        oldValue: incident.severity,
        newValue: input.severity,
        note: input.changeReason.trim() || null,
        eventTime: input.eventTime,
        operationId,
      });
      this.audit(actor.id, 'incident_severity_changed', 'incident', incidentId, {
        incidentNumber: incident.number,
        before: JSON.stringify({ severity: incident.severity }),
        after: JSON.stringify({ severity: input.severity }),
        entityLabel: incident.number,
      });
    }
    // Internal owner is now mandatory (updateIncidentSchema's own
    // superRefine guarantees input.ownerUserId is non-null by the time
    // parseOrThrow returns) -- the new-label lookup never falls back to an
    // external name anymore, mirroring update_incident's own
    // v_new_owner_label (migration 0032). A legacy ownerExternalName
    // payload key is tolerated but never read here (updateIncidentSchema
    // no longer even has the key); ownerExternalName is therefore never
    // written or cleared by this flow.
    const newOwnerLabel = this.ownerLabel(input.ownerUserId, null);
    const oldOwnerLabel = this.ownerLabel(incident.ownerUserId, incident.ownerExternalName);
    const ownerChanged = input.ownerUserId !== incident.ownerUserId;
    if (ownerChanged) {
      this.addEvent(incidentId, 'assignment_change', actor.id, {
        field: 'owner',
        oldValue: oldOwnerLabel,
        newValue: newOwnerLabel,
        eventTime: input.eventTime,
        operationId,
      });
      this.audit(actor.id, 'incident_assigned', 'incident', incidentId, {
        incidentNumber: incident.number,
        before: JSON.stringify({ owner: oldOwnerLabel }),
        after: JSON.stringify({ owner: newOwnerLabel }),
        entityLabel: incident.number,
      });
      if (input.ownerUserId && input.ownerUserId !== actor.id) {
        this.notify(input.ownerUserId, 'incident_assigned', 'action_required', `תקלה ${incident.number} הוקצתה אליך.`, {
          incidentId,
          dedupeKey: `assign-${incidentId}-${ts}`,
        });
      }
    }
    // Additive external handling party: preserve-on-omit (key absent from
    // the parsed input, i.e. `undefined`), update-on-supply, clear-on-
    // explicit-null -- mirroring update_incident's v_new_ext_* handling
    // (migration 0032) exactly. One event, field='external_handler',
    // distinct from the 'owner' event above, only on a genuine change to
    // any of the three fields. (Values already computed and validated
    // above, before any side effect.)
    if (newExtName !== oldExtName || newExtPerson !== oldExtPerson || newExtDetails !== oldExtDetails) {
      this.addEvent(incidentId, 'assignment_change', actor.id, {
        field: 'external_handler',
        oldValue: externalHandlerSnapshot(oldExtName, oldExtPerson, oldExtDetails),
        newValue: externalHandlerSnapshot(newExtName, newExtPerson, newExtDetails),
        eventTime: input.eventTime,
        operationId,
      });
      this.audit(actor.id, 'incident_external_handler_changed', 'incident', incidentId, {
        incidentNumber: incident.number,
        before: JSON.stringify({
          externalHandlerName: oldExtName,
          externalHandlerContactPerson: oldExtPerson,
          externalHandlerContactDetails: oldExtDetails,
        }),
        after: JSON.stringify({
          externalHandlerName: newExtName,
          externalHandlerContactPerson: newExtPerson,
          externalHandlerContactDetails: newExtDetails,
        }),
        entityLabel: incident.number,
      });
    }

    // Optional current-suspected-cause change -- omitted key means
    // "untouched" (no reconfirmation demanded on every update); a
    // resubmission of the SAME value writes no history row and no event,
    // mirroring update_incident's own v_cause_changed check exactly.
    const suspectedCauseProvided = input.suspectedCause !== undefined;
    const newSuspectedCauseOtherDetail =
      input.suspectedCause === 'other' ? (input.suspectedCauseOtherDetail ?? '').trim() || null : null;
    const causeChanged =
      suspectedCauseProvided &&
      (input.suspectedCause !== incident.currentSuspectedCause ||
        newSuspectedCauseOtherDetail !== incident.currentSuspectedCauseOtherDetail);
    if (causeChanged && input.suspectedCause) {
      this.recordCauseAssessment(
        incidentId,
        input.suspectedCause,
        newSuspectedCauseOtherDetail,
        incident.reopenCount,
        actor.id,
        input.eventTime,
        operationId,
      );
      this.addEvent(incidentId, 'cause_assessment_changed', actor.id, {
        field: 'current_suspected_cause',
        oldValue: incident.currentSuspectedCause ?? '',
        newValue: input.suspectedCause,
        eventTime: input.eventTime,
        operationId,
      });
    }
    // Cumulative structured treatment actions performed in this update --
    // never replaces the required free-text actionsTaken above.
    this.insertTreatmentActions(incidentId, input.treatmentActions, incident.reopenCount, input.eventTime, actor.id, operationId);
    if (suspectedCauseProvided) {
      incident.currentSuspectedCause = input.suspectedCause ?? null;
      incident.currentSuspectedCauseOtherDetail = newSuspectedCauseOtherDetail;
    }

    incident.status = input.status;
    incident.severity = input.severity;
    // operational_impact is a creation-time opening fact only -- update_incident
    // no longer revises it (historical values and impact_change events from
    // before this PR remain readable, but no new ones are written).
    incident.ownerUserId = input.ownerUserId;
    // ownerExternalName is a frozen historical column -- never written or
    // cleared here (see above).
    incident.externalHandlerName = newExtName;
    incident.externalHandlerContactPerson = newExtPerson;
    incident.externalHandlerContactDetails = newExtDetails;
    // next_update_due / no_deadline_reason are left untouched -- the new
    // update form never asks for either, so any existing (possibly legacy)
    // value simply carries forward unchanged.
    // incidents.reportedToOps/reportedToOpsRecipient are opening-time facts,
    // frozen after creation -- this flow no longer reads or mutates them at
    // all (see update-specific reporting on the IncidentUpdate row itself,
    // above, and migration 0031's removal of the equivalent RPC mutation).
    incident.version += 1;
    incident.updatedAt = ts;
    incident.updatedBy = actor.id;
    incident.lastUpdateAt = ts;

    // No generic catch-all audit event here: status/severity/owner/external-
    // handler changes each already write their own dedicated event above,
    // and this update flow has no other incident-row field left to revise
    // (operationalImpact is creation-only; see the comment above). A
    // content-only submission that changes none of those four therefore
    // correctly writes zero audit_logs rows -- no noise for a no-op.

    // Operational broadcast: unconditional -- actionsTaken is mandatory on
    // every submission, so "a treatment update was added" is always true
    // here. The new owner (if this same call also reassigned the incident)
    // is excluded -- they already got the personal notification above.
    this.notifyOperationalRecipients(
      actor.id,
      'incident_updated',
      `נוסף עדכון לתקלה ${incident.number} על ידי ${actor.fullName}`,
      { incidentId, operationId, excludeUserIds: ownerChanged && input.ownerUserId ? [input.ownerUserId] : [] },
    );
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
    this.validateEventTime(incident, input.eventTime);

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
      currentStatusText: input.currentStatusText.trim() || null,
      // Technician updates carry no protected fields and no update-specific
      // reporting -- this payload has no such keys at all.
      updateReportedToOps: null,
      updateReportedToOpsRecipient: null,
      updateReportedToComms: null,
      updateReportedToCommsRecipient: null,
      updateWisdomReported: null,
      // "הערה נוספת": a separate, optional, raw user note on THIS update
      // only -- storing it grants no protected-field capability, exactly
      // like every other field on this content-only schema.
      userNote: (input.note ?? '').trim() || null,
      createdAt: ts,
    };
    this.db.incidentUpdates.push(update);
    const operationId = newId();
    this.addEvent(incidentId, 'update', actor.id, {
      eventTime: input.eventTime,
      refId: update.id,
      operationId,
    });

    // Optional cause/action classification -- permitted here: this is
    // operational technical detail, not one of the protected owner/
    // status/severity/reporting fields, and the spec explicitly grants it
    // to "anyone currently allowed to post the relevant incident update."
    const suspectedCauseProvided = input.suspectedCause !== undefined;
    const newSuspectedCauseOtherDetail =
      input.suspectedCause === 'other' ? (input.suspectedCauseOtherDetail ?? '').trim() || null : null;
    const causeChanged =
      suspectedCauseProvided &&
      (input.suspectedCause !== incident.currentSuspectedCause ||
        newSuspectedCauseOtherDetail !== incident.currentSuspectedCauseOtherDetail);
    if (causeChanged && input.suspectedCause) {
      this.recordCauseAssessment(
        incidentId,
        input.suspectedCause,
        newSuspectedCauseOtherDetail,
        incident.reopenCount,
        actor.id,
        input.eventTime,
        operationId,
      );
      this.addEvent(incidentId, 'cause_assessment_changed', actor.id, {
        field: 'current_suspected_cause',
        oldValue: incident.currentSuspectedCause ?? '',
        newValue: input.suspectedCause,
        eventTime: input.eventTime,
        operationId,
      });
    }
    this.insertTreatmentActions(incidentId, input.treatmentActions, incident.reopenCount, input.eventTime, actor.id, operationId);
    if (suspectedCauseProvided) {
      incident.currentSuspectedCause = input.suspectedCause ?? null;
      incident.currentSuspectedCauseOtherDetail = newSuspectedCauseOtherDetail;
    }

    incident.version += 1;
    incident.updatedAt = ts;
    incident.updatedBy = actor.id;
    incident.lastUpdateAt = ts;
    this.audit(actor.id, 'incident_technical_update', 'incident', incidentId, {
      incidentNumber: incident.number,
    });
    this.notifyOperationalRecipients(
      actor.id,
      'incident_updated',
      `נוסף עדכון לתקלה ${incident.number} על ידי ${actor.fullName}`,
      { incidentId, operationId },
    );
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

    // Compute the merged external-handler values and validate them BEFORE
    // any event/audit/notification/mutation -- a rejected payload must
    // leave the incident, its events, audits, and notifications untouched.
    const oldExtName = incident.externalHandlerName;
    const oldExtPerson = incident.externalHandlerContactPerson;
    const oldExtDetails = incident.externalHandlerContactDetails;
    const newExtName = input.externalHandlerName !== undefined
      ? (input.externalHandlerName ?? '').trim() || null
      : oldExtName;
    const newExtPerson = input.externalHandlerContactPerson !== undefined
      ? (input.externalHandlerContactPerson ?? '').trim() || null
      : oldExtPerson;
    const newExtDetails = input.externalHandlerContactDetails !== undefined
      ? (input.externalHandlerContactDetails ?? '').trim() || null
      : oldExtDetails;
    this.assertExternalHandlerValid(newExtName, newExtPerson, newExtDetails);

    const ts = this.now().toISOString();
    const operationId = newId();

    // Gated on a GENUINE owner change: assignIncident is also the entry
    // point for an external-handler-only edit (same owner, changed
    // external handler fields), which must never fabricate an 'owner'
    // event, an incident_assigned audit row, or a reassignment
    // notification.
    if (input.ownerUserId !== incident.ownerUserId) {
      const oldLabel = this.ownerLabel(incident.ownerUserId, incident.ownerExternalName);
      const newLabel = this.ownerLabel(input.ownerUserId, null);
      this.addEvent(incidentId, 'assignment_change', actor.id, {
        field: 'owner',
        oldValue: oldLabel,
        newValue: newLabel,
        note: input.note.trim() || null,
        operationId,
      });
      this.audit(actor.id, 'incident_assigned', 'incident', incidentId, {
        incidentNumber: incident.number,
        before: JSON.stringify({ owner: oldLabel }),
        after: JSON.stringify({ owner: newLabel }),
        entityLabel: incident.number,
      });
      if (input.ownerUserId && input.ownerUserId !== actor.id) {
        this.notify(input.ownerUserId, 'incident_assigned', 'action_required', `תקלה ${incident.number} הוקצתה אליך.`, {
          incidentId,
          dedupeKey: `assign-${incidentId}-${ts}`,
        });
      }
    }

    if (newExtName !== oldExtName || newExtPerson !== oldExtPerson || newExtDetails !== oldExtDetails) {
      this.addEvent(incidentId, 'assignment_change', actor.id, {
        field: 'external_handler',
        oldValue: externalHandlerSnapshot(oldExtName, oldExtPerson, oldExtDetails),
        newValue: externalHandlerSnapshot(newExtName, newExtPerson, newExtDetails),
        operationId,
      });
      this.audit(actor.id, 'incident_external_handler_changed', 'incident', incidentId, {
        incidentNumber: incident.number,
        before: JSON.stringify({
          externalHandlerName: oldExtName,
          externalHandlerContactPerson: oldExtPerson,
          externalHandlerContactDetails: oldExtDetails,
        }),
        after: JSON.stringify({
          externalHandlerName: newExtName,
          externalHandlerContactPerson: newExtPerson,
          externalHandlerContactDetails: newExtDetails,
        }),
        entityLabel: incident.number,
      });
    }

    incident.ownerUserId = input.ownerUserId;
    // ownerExternalName is a frozen historical column -- never written or
    // cleared by this flow.
    incident.externalHandlerName = newExtName;
    incident.externalHandlerContactPerson = newExtPerson;
    incident.externalHandlerContactDetails = newExtDetails;
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
    // Mirrors close_incident's own bounds check (migration 0033, same
    // guarded-cast pattern already established by cancel_incident/
    // update_incident): checked before any mutation below, so a rejected
    // closure time leaves the incident, events, audits, and notifications
    // byte-for-byte unchanged. An unparseable value (e.g. "not-a-date")
    // produces an Invalid Date, whose comparisons against a valid Date are
    // always false -- without this explicit check it would silently pass
    // the bounds test below instead of being rejected, unlike the guarded
    // cast on the server side.
    const closureEventTime = new Date(input.eventTime);
    if (Number.isNaN(closureEventTime.getTime())) {
      throw new AppError('VALIDATION', 'מועד סגירת התקלה אינו תקין.');
    }
    if (closureEventTime < new Date(incident.discoveredAt) || closureEventTime.getTime() > this.now().getTime() + 5 * 60_000) {
      throw new AppError('VALIDATION', 'מועד סגירת התקלה אינו תקין.');
    }
    const fullyReady = input.readiness === 'full';
    if (!fullyReady) this.validateOwner(input.ownerUserId ?? null);

    const ts = this.now().toISOString();
    const oldReportedToOps = incident.reportedToOps;
    const oldRecipient = incident.reportedToOpsRecipient;
    // External handling is independent of readiness -- captured once,
    // before the branch split, mirroring close_incident's own
    // v_old_ext_*/v_new_ext_* (migration 0032). Both branches gain the
    // three columns; only the full-readiness branch never touches
    // ownerUserId/ownerExternalName (unchanged from before this feature).
    const oldExtName = incident.externalHandlerName;
    const oldExtPerson = incident.externalHandlerContactPerson;
    const oldExtDetails = incident.externalHandlerContactDetails;
    const newExtName = input.externalHandlerName !== undefined
      ? (input.externalHandlerName ?? '').trim() || null
      : oldExtName;
    const newExtPerson = input.externalHandlerContactPerson !== undefined
      ? (input.externalHandlerContactPerson ?? '').trim() || null
      : oldExtPerson;
    const newExtDetails = input.externalHandlerContactDetails !== undefined
      ? (input.externalHandlerContactDetails ?? '').trim() || null
      : oldExtDetails;
    this.assertExternalHandlerValid(newExtName, newExtPerson, newExtDetails);
    const extChanged = newExtName !== oldExtName || newExtPerson !== oldExtPerson || newExtDetails !== oldExtDetails;
    incident.rootCause = input.rootCause.trim();
    incident.resolution = input.resolution.trim();
    incident.followUpNotes = input.followUpNotes.trim() || null;
    incident.followUpRequired = !fullyReady;
    incident.reportedToOps = input.reportedToOps;
    incident.reportedToOpsRecipient =
      input.reportedToOps === 'yes' ? (input.reportedToOpsRecipient ?? '').trim() || null : null;
    incident.externalHandlerName = newExtName;
    incident.externalHandlerContactPerson = newExtPerson;
    incident.externalHandlerContactDetails = newExtDetails;
    incident.version += 1;
    incident.updatedAt = ts;
    incident.updatedBy = actor.id;
    incident.lastUpdateAt = ts;
    const operationId = newId();
    const oldStatusForAudit = incident.status;

    if (fullyReady) {
      // Full readiness: the incident actually closes. Owner columns are
      // untouched here -- unchanged from before this feature.
      incident.status = 'closed';
      incident.closedAt = input.eventTime;
      incident.closedBy = actor.id;
      incident.readinessAtClose = input.readiness;
      incident.nextUpdateDue = null;
      incident.noDeadlineReason = 'התקלה נסגרה';

      // Structured closure classification -- confirmedCause/treatmentOutcome/
      // resolutionAttribution are guaranteed present by closeIncidentSchema's
      // own superRefine whenever readiness === 'full', so the non-null
      // assertions below only narrow an already-validated shape for TS.
      const confirmedCause = input.confirmedCause!;
      const treatmentOutcome = input.treatmentOutcome!;
      const resolutionAttribution = input.resolutionAttribution!;
      // New actions recorded inline during closure, then previously-
      // recorded actions selected for this closure -- re-validated against
      // this incident and its CURRENT cycle (rejects a stale/foreign id),
      // combined and de-duplicated, mirroring close_incident_impl exactly
      // (migration 0047).
      const newActionIds = this.insertTreatmentActions(
        incidentId,
        input.newTreatmentActions,
        incident.reopenCount,
        input.eventTime,
        actor.id,
        operationId,
      );
      const validSelectedIds = input.resolutionActionIds.filter((id) =>
        this.treatmentActionRows().some(
          (a) => a.id === id && a.incidentId === incidentId && a.cycleNumber === incident.reopenCount,
        ),
      );
      const linkedActionIds = Array.from(new Set([...newActionIds, ...validSelectedIds]));
      const closureId = newId();
      this.closureRows().push({
        id: closureId,
        incidentId,
        cycleNumber: incident.reopenCount,
        operationId,
        confirmedCause,
        confirmedCauseOtherDetail:
          confirmedCause === 'other' ? (input.confirmedCauseOtherDetail ?? '').trim() || null : null,
        treatmentOutcome,
        treatmentOutcomeOtherDetail:
          treatmentOutcome === 'other' ? (input.treatmentOutcomeOtherDetail ?? '').trim() || null : null,
        resolutionAttribution,
        resolutionAttributionOtherDetail:
          resolutionAttribution === 'other' ? (input.resolutionAttributionOtherDetail ?? '').trim() || null : null,
        resolutionActionIds: linkedActionIds,
        recordedBy: actor.id,
        eventTime: input.eventTime,
        recordedAt: ts,
        createdAt: ts,
      });

      this.addEvent(incidentId, 'closed', actor.id, {
        newValue: input.readiness,
        note: `סיבת התקלה: ${input.rootCause.trim()}\nהפתרון שבוצע: ${input.resolution.trim()}`,
        // "הערה נוספת": a separate, optional, raw user note -- never folded
        // into the generated note above. Blank/whitespace-only -> null.
        userNote: (input.note ?? '').trim() || null,
        refId: closureId,
        eventTime: input.eventTime,
        operationId,
      });
      this.audit(actor.id, 'incident_closed', 'incident', incidentId, {
        incidentNumber: incident.number,
        before: JSON.stringify({ status: oldStatusForAudit }),
        after: JSON.stringify({ status: incident.status, readiness: input.readiness }),
        entityLabel: incident.number,
      });
      if (incident.reportedToOps !== oldReportedToOps || incident.reportedToOpsRecipient !== oldRecipient) {
        this.addEvent(incidentId, 'reported_to_ops_change', actor.id, {
          field: 'reported_to_ops_recipient',
          oldValue: oldRecipient,
          newValue: incident.reportedToOpsRecipient,
          note: `דווח למבצעים: ${reportedToOpsLabels[incident.reportedToOps]}${incident.reportedToOpsRecipient ? ` (${incident.reportedToOpsRecipient})` : ''}`,
          eventTime: input.eventTime,
          operationId,
        });
      }
      if (extChanged) {
        this.addEvent(incidentId, 'assignment_change', actor.id, {
          field: 'external_handler',
          oldValue: externalHandlerSnapshot(oldExtName, oldExtPerson, oldExtDetails),
          newValue: externalHandlerSnapshot(newExtName, newExtPerson, newExtDetails),
          eventTime: input.eventTime,
          operationId,
        });
        this.audit(actor.id, 'incident_external_handler_changed', 'incident', incidentId, {
          incidentNumber: incident.number,
          before: JSON.stringify({
            externalHandlerName: oldExtName,
            externalHandlerContactPerson: oldExtPerson,
            externalHandlerContactDetails: oldExtDetails,
          }),
          after: JSON.stringify({
            externalHandlerName: newExtName,
            externalHandlerContactPerson: newExtPerson,
            externalHandlerContactDetails: newExtDetails,
          }),
          entityLabel: incident.number,
        });
      }
      this.notifyOperationalRecipients(
        actor.id,
        'incident_closed',
        `תקלה ${incident.number} נסגרה על ידי ${actor.fullName}`,
        { incidentId, operationId },
      );
    } else {
      // Incomplete readiness: the incident stays active as "כשירות חלקית" —
      // it is never marked closed while follow-up is still outstanding.
      // readinessAtClose is left untouched: it only ever describes readiness
      // AT AN ACTUAL CLOSE, and this incident has not closed.
      const oldStatus = incident.status;
      incident.status = 'partial_readiness';
      incident.ownerUserId = input.ownerUserId ?? null;
      // ownerExternalName is a frozen historical column -- never written or
      // cleared by this flow.
      if (!incident.nextUpdateDue) {
        incident.noDeadlineReason = 'התקלה נותרה פעילה עם כשירות לא מלאה, ממתינה להשלמת פעולות המשך';
      }

      this.addEvent(incidentId, 'status_change', actor.id, {
        field: 'status',
        oldValue: oldStatus,
        newValue: 'partial_readiness',
        note: `סיבת התקלה: ${input.rootCause.trim()}\nהפתרון החלקי שבוצע: ${input.resolution.trim()}\nפעולות המשך: ${incident.followUpNotes}\nגורם מטפל אחראי המשך: ${this.ownerLabel(incident.ownerUserId, null)}`,
        // "הערה נוספת": a separate, optional, raw user note -- never folded
        // into the generated note above. Blank/whitespace-only -> null.
        userNote: (input.note ?? '').trim() || null,
        eventTime: input.eventTime,
        operationId,
      });
      this.audit(actor.id, 'incident_partial_readiness', 'incident', incidentId, {
        incidentNumber: incident.number,
        before: JSON.stringify({ status: oldStatus }),
        after: JSON.stringify({ status: incident.status, readiness: input.readiness }),
        entityLabel: incident.number,
      });
      if (incident.reportedToOps !== oldReportedToOps || incident.reportedToOpsRecipient !== oldRecipient) {
        this.addEvent(incidentId, 'reported_to_ops_change', actor.id, {
          field: 'reported_to_ops_recipient',
          oldValue: oldRecipient,
          newValue: incident.reportedToOpsRecipient,
          note: `דווח למבצעים: ${reportedToOpsLabels[incident.reportedToOps]}${incident.reportedToOpsRecipient ? ` (${incident.reportedToOpsRecipient})` : ''}`,
          eventTime: input.eventTime,
          operationId,
        });
      }
      if (extChanged) {
        this.addEvent(incidentId, 'assignment_change', actor.id, {
          field: 'external_handler',
          oldValue: externalHandlerSnapshot(oldExtName, oldExtPerson, oldExtDetails),
          newValue: externalHandlerSnapshot(newExtName, newExtPerson, newExtDetails),
          eventTime: input.eventTime,
          operationId,
        });
        this.audit(actor.id, 'incident_external_handler_changed', 'incident', incidentId, {
          incidentNumber: incident.number,
          before: JSON.stringify({
            externalHandlerName: oldExtName,
            externalHandlerContactPerson: oldExtPerson,
            externalHandlerContactDetails: oldExtDetails,
          }),
          after: JSON.stringify({
            externalHandlerName: newExtName,
            externalHandlerContactPerson: newExtPerson,
            externalHandlerContactDetails: newExtDetails,
          }),
          entityLabel: incident.number,
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

    const operationId = newId();
    this.addEvent(incidentId, 'cancelled', actor.id, {
      field: 'status',
      oldValue: oldStatus,
      newValue: 'cancelled',
      note: reason,
      eventTime: input.eventTime,
      operationId,
    });
    this.audit(actor.id, 'incident_cancelled', 'incident', incidentId, {
      incidentNumber: incident.number,
      before: JSON.stringify({ status: oldStatus }),
      after: JSON.stringify({ status: 'cancelled', cancellationReason: reason }),
      entityLabel: incident.number,
      summary: reason,
    });
    this.notifyOperationalRecipients(actor.id, 'incident_cancelled', `תקלה ${incident.number} בוטלה`, {
      incidentId,
      operationId,
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

    // Compute the merged external-handler values and validate them BEFORE
    // any event/audit/notification/mutation -- a rejected external-handler
    // payload must leave the incident, its events, and its audits
    // byte-for-byte unchanged.
    const oldExtName = incident.externalHandlerName;
    const oldExtPerson = incident.externalHandlerContactPerson;
    const oldExtDetails = incident.externalHandlerContactDetails;
    const newExtName = input.externalHandlerName !== undefined
      ? (input.externalHandlerName ?? '').trim() || null
      : oldExtName;
    const newExtPerson = input.externalHandlerContactPerson !== undefined
      ? (input.externalHandlerContactPerson ?? '').trim() || null
      : oldExtPerson;
    const newExtDetails = input.externalHandlerContactDetails !== undefined
      ? (input.externalHandlerContactDetails ?? '').trim() || null
      : oldExtDetails;
    this.assertExternalHandlerValid(newExtName, newExtPerson, newExtDetails);

    const ts = this.now().toISOString();
    const operationId = newId();
    this.addEvent(incidentId, 'reopened', actor.id, {
      note: input.reason.trim(),
      oldValue: 'closed',
      newValue: 'reopened',
      operationId,
    });
    this.audit(actor.id, 'incident_reopened', 'incident', incidentId, {
      incidentNumber: incident.number,
      before: JSON.stringify({ status: 'closed' }),
      after: JSON.stringify({ status: 'reopened' }),
      entityLabel: incident.number,
      summary: input.reason.trim(),
    });

    if (newExtName !== oldExtName || newExtPerson !== oldExtPerson || newExtDetails !== oldExtDetails) {
      this.addEvent(incidentId, 'assignment_change', actor.id, {
        field: 'external_handler',
        oldValue: externalHandlerSnapshot(oldExtName, oldExtPerson, oldExtDetails),
        newValue: externalHandlerSnapshot(newExtName, newExtPerson, newExtDetails),
        operationId,
      });
      this.audit(actor.id, 'incident_external_handler_changed', 'incident', incidentId, {
        incidentNumber: incident.number,
        before: JSON.stringify({
          externalHandlerName: oldExtName,
          externalHandlerContactPerson: oldExtPerson,
          externalHandlerContactDetails: oldExtDetails,
        }),
        after: JSON.stringify({
          externalHandlerName: newExtName,
          externalHandlerContactPerson: newExtPerson,
          externalHandlerContactDetails: newExtDetails,
        }),
        entityLabel: incident.number,
      });
    }

    incident.status = 'reopened';
    incident.ownerUserId = input.ownerUserId;
    // ownerExternalName is a frozen historical column -- never written or
    // cleared by this flow.
    incident.externalHandlerName = newExtName;
    incident.externalHandlerContactPerson = newExtPerson;
    incident.externalHandlerContactDetails = newExtDetails;
    // next_update_due / no_deadline_reason are left untouched -- reopening
    // no longer asks for a next-update expectation, so whatever
    // close_incident last left them as simply carries forward.
    incident.reopenCount += 1;
    // Closure record stays in the timeline event; live fields reset so the
    // incident is fully open again.
    incident.closedAt = null;
    incident.closedBy = null;
    incident.followUpRequired = false;
    incident.followUpCompletedAt = null;
    incident.followUpCompletedBy = null;
    // Never carry the previous cycle's suspected cause -- let alone the
    // just-superseded confirmed cause from the prior closure classification
    // -- forward as if freshly reconfirmed. Every prior IncidentCauseAssessment
    // row and the prior IncidentClosureClassification row are untouched
    // (append-only) and remain fully visible as history; the reopened cycle
    // simply begins with no current assessment.
    incident.currentSuspectedCause = null;
    incident.currentSuspectedCauseOtherDetail = null;
    incident.version += 1;
    incident.updatedAt = ts;
    incident.updatedBy = actor.id;
    incident.lastUpdateAt = ts;

    if (incident.ownerUserId && incident.ownerUserId !== actor.id) {
      this.notify(
        incident.ownerUserId,
        'incident_reopened',
        'action_required',
        `תקלה ${incident.number} נפתחה מחדש והוקצתה אליך.`,
        { incidentId, dedupeKey: `reopen-${incidentId}-${ts}` },
      );
    }
    this.notifyOperationalRecipients(actor.id, 'incident_reopened', `תקלה ${incident.number} נפתחה מחדש`, {
      incidentId,
      operationId,
      excludeUserIds: incident.ownerUserId ? [incident.ownerUserId] : [],
    });
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
      operationId: newId(),
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
    this.addEvent(incidentId, 'follow_up_completed', actor.id, { note: note.trim(), operationId: newId() });
    this.audit(actor.id, 'incident_follow_up_completed', 'incident', incidentId, {
      incidentNumber: incident.number,
    });
    this.persist();
    return { ...incident };
  }

  // --- related incidents ---
  // Mirrors supabase/migrations/0050's four RPCs as closely as the two
  // languages allow -- see domain/similarity.ts for the shared scoring
  // algorithm both this class and the SQL RPC independently implement.

  private static readonly RELATION_LINK_WINDOW_MS = 10 * 60_000;

  async suggestSimilarIncidents(
    session: Session,
    query: { systemId: string; locationId: string | null; reportedDomain: IncidentDomain | null; description: string },
  ): Promise<SimilarIncidentSuggestion[]> {
    this.requireCap(session, 'view_all_incidents');
    const candidates = this.db.incidents.filter((i) => isOpen(i.status)).map(incidentToSimilarityCandidate);
    return selectSimilarIncidentSuggestions(query, candidates);
  }

  async getIncidentRelations(session: Session, incidentId: string): Promise<IncidentRelation[]> {
    this.requireCap(session, 'view_all_incidents');
    return this.relationRows()
      .filter((r) => r.incidentAId === incidentId || r.incidentBId === incidentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => {
        const otherId = r.incidentAId === incidentId ? r.incidentBId : r.incidentAId;
        const other = this.db.incidents.find((i) => i.id === otherId);
        // Referential integrity is guaranteed by construction (relations are
        // only ever created against real incident ids, and incidents are
        // never deleted) -- this is defensive, never expected to fire.
        if (!other) throw new AppError('NOT_FOUND', 'התקלה המקושרת לא נמצאה.');
        return {
          id: r.id,
          relatedIncident: this.incidentSummary(other),
          relationType: 'related' as const,
          createdBy: r.createdBy,
          createdAt: r.createdAt,
        };
      });
  }

  /** Shared insert/audit logic for both linkIncidentOnCreation and
   *  manageIncidentRelation's 'link' branch -- canonical ordering,
   *  idempotent no-op on an already-linked pair, symmetric audit rows
   *  correlated via a shared operationId (mirrors write_audit's p_metadata
   *  usage on the SQL side -- see 0050's own comment on why that, not a
   *  new write_audit parameter). */
  private linkRelationRows(actorId: string, incidentId: string, relatedIncidentId: string): void {
    const [a, b] = [incidentId, relatedIncidentId].sort();
    if (this.relationRows().some((r) => r.incidentAId === a && r.incidentBId === b)) {
      return; // already linked: idempotent success, no duplicate audit row
    }
    const operationId = newId();
    this.relationRows().push({
      id: newId(),
      incidentAId: a,
      incidentBId: b,
      createdBy: actorId,
      createdAt: this.now().toISOString(),
      operationId,
    });
    const incident = this.getIncidentOrThrow(incidentId);
    const related = this.getIncidentOrThrow(relatedIncidentId);
    this.audit(actorId, 'incident_related', 'incident', incidentId, {
      incidentNumber: incident.number,
      entityLabel: incident.number,
      summary: `קושרה לתקלה ${related.number}`,
      after: JSON.stringify({ relatedIncidentId, relatedIncidentNumber: related.number }),
      metadata: JSON.stringify({ relationOperationId: operationId }),
      correlationId: operationId,
    });
    this.audit(actorId, 'incident_related', 'incident', relatedIncidentId, {
      incidentNumber: related.number,
      entityLabel: related.number,
      summary: `קושרה לתקלה ${incident.number}`,
      after: JSON.stringify({ relatedIncidentId: incidentId, relatedIncidentNumber: incident.number }),
      metadata: JSON.stringify({ relationOperationId: operationId }),
      correlationId: operationId,
    });
  }

  async linkIncidentOnCreation(session: Session, newIncidentId: string, relatedIncidentId: string): Promise<void> {
    const actor = this.requireSession(session);
    if (newIncidentId === relatedIncidentId) {
      throw new AppError('VALIDATION', 'לא ניתן לקשר תקלה לעצמה.');
    }
    const incident = this.getIncidentOrThrow(newIncidentId);
    if (incident.createdBy !== actor.id) {
      throw new AppError('FORBIDDEN', 'ניתן לקשר רק תקלה שפתחת בעצמך, בסמוך לפתיחתה.');
    }
    if (this.now().getTime() - new Date(incident.createdAt).getTime() > LocalDemoRepository.RELATION_LINK_WINDOW_MS) {
      throw new AppError(
        'FORBIDDEN',
        'החלון לקישור אוטומטי בעת פתיחת התקלה הסתיים -- ניתן לבקש מאחמ״ש קישור ידני.',
      );
    }
    const related = this.getIncidentOrThrow(relatedIncidentId);
    if (!isOpen(related.status)) {
      throw new AppError(
        'STALE_TARGET',
        'התקלה המקושרת כבר אינה פעילה -- ניתן לבקש מאחמ״ש קישור ידני מאוחר יותר.',
      );
    }
    this.linkRelationRows(actor.id, newIncidentId, relatedIncidentId);
    this.persist();
  }

  async manageIncidentRelation(
    session: Session,
    incidentId: string,
    relatedIncidentId: string,
    action: 'link' | 'unlink',
  ): Promise<void> {
    const actor = this.requireCap(session, 'manage_incident_relations');
    if (incidentId === relatedIncidentId) {
      throw new AppError('VALIDATION', 'לא ניתן לקשר תקלה לעצמה.');
    }
    this.getIncidentOrThrow(incidentId);
    this.getIncidentOrThrow(relatedIncidentId);

    if (action === 'link') {
      this.linkRelationRows(actor.id, incidentId, relatedIncidentId);
      this.persist();
      return;
    }

    const [a, b] = [incidentId, relatedIncidentId].sort();
    const rows = this.relationRows();
    const index = rows.findIndex((r) => r.incidentAId === a && r.incidentBId === b);
    if (index === -1) {
      // Nothing to remove: idempotent success, no phantom audit row.
      return;
    }
    rows.splice(index, 1);
    const operationId = newId();
    const incident = this.getIncidentOrThrow(incidentId);
    const related = this.getIncidentOrThrow(relatedIncidentId);
    this.audit(actor.id, 'incident_unrelated', 'incident', incidentId, {
      incidentNumber: incident.number,
      entityLabel: incident.number,
      summary: `הוסר קישור לתקלה ${related.number}`,
      before: JSON.stringify({ relatedIncidentId, relatedIncidentNumber: related.number }),
      metadata: JSON.stringify({ relationOperationId: operationId }),
      correlationId: operationId,
    });
    this.audit(actor.id, 'incident_unrelated', 'incident', relatedIncidentId, {
      incidentNumber: related.number,
      entityLabel: related.number,
      summary: `הוסר קישור לתקלה ${incident.number}`,
      before: JSON.stringify({ relatedIncidentId: incidentId, relatedIncidentNumber: incident.number }),
      metadata: JSON.stringify({ relationOperationId: operationId }),
      correlationId: operationId,
    });
    this.persist();
  }

  async searchIncidentsForRelation(session: Session, query: string, excludeIncidentId: string): Promise<IncidentSummary[]> {
    this.requireCap(session, 'manage_incident_relations');
    const q = query.trim();
    if (q.length < 2) return [];
    const systemsById = new Map(this.db.systems.map((s) => [s.id, s.name]));
    const locationsById = new Map(this.db.locations.map((l) => [l.id, l.name]));
    return this.db.incidents
      .filter((i) => i.id !== excludeIncidentId)
      .filter((i) => {
        const haystack = [i.number, i.description, systemsById.get(i.systemId) ?? '', locationsById.get(i.locationId) ?? ''].join(' ');
        return haystack.includes(q);
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10)
      .map((i) => this.incidentSummary(i));
  }

  // --- notifications ---

  async listNotifications(session: Session): Promise<AppNotification[]> {
    const actor = this.requireSession(session);
    return this.db.notifications
      .filter((n) => n.userId === actor.id)
      // 'update_overdue': the next-update-ETA concept was removed from the
      // active product -- no new row of this type is ever written, but a
      // historical row must not resurface in the active notification list
      // or the unread badge (which derives its count from this same
      // result). The row itself is preserved in storage, not deleted.
      .filter((n) => n.type !== 'update_overdue')
      // Cleared (נקה הכל) rows are preserved in storage, never deleted, but
      // excluded from every active list/filter tab -- see clearNotifications.
      .filter((n) => !n.dismissedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ dedupeKey: _dedupeKey, dismissedAt: _dismissedAt, ...n }) => n);
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

  async clearNotifications(session: Session): Promise<void> {
    const actor = this.requireSession(session);
    const now = this.now().toISOString();
    for (const n of this.db.notifications) {
      if (n.userId === actor.id && !n.dismissedAt) n.dismissedAt = now;
    }
    this.persist();
  }

  // --- audit ---

  async listAuditLogs(
    session: Session,
    filters: AuditFilters = {},
    page: number = 1,
    pageSize: number = 25,
  ): Promise<AuditLogPage> {
    const actor = this.requireSession(session);
    if (!hasCapability(actor.role, 'view_audit_log', this.db.policy, actor.id)) {
      throw new AppError('FORBIDDEN', 'אין לך הרשאה לצפות ביומן הביקורת.');
    }
    let rows = [...this.db.auditLogs];
    if (filters.actorId) rows = rows.filter((r) => r.actorId === filters.actorId);
    if (filters.action) rows = rows.filter((r) => r.action === filters.action);
    if (filters.entityType) rows = rows.filter((r) => r.entityType === filters.entityType);
    if (filters.from) rows = rows.filter((r) => r.createdAt >= filters.from!);
    if (filters.to) rows = rows.filter((r) => r.createdAt <= filters.to!);
    if (filters.search) {
      const q = filters.search.trim().toLocaleLowerCase('he-IL');
      if (q) {
        rows = rows.filter((r) =>
          r.entityLabel?.toLocaleLowerCase('he-IL').includes(q)
          || r.incidentNumber?.toLocaleLowerCase('he-IL').includes(q)
          || r.summary?.toLocaleLowerCase('he-IL').includes(q),
        );
      }
    }
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const total = rows.length;
    // Server-side pagination, hard-clamped -- mirrors list_audit_events'
    // own clamp so demo mode cannot silently diverge into an unbounded
    // fetch just because there is no real network boundary here.
    const clampedSize = Math.min(Math.max(pageSize, 1), 100);
    const clampedPage = Math.max(page, 1);
    const start = (clampedPage - 1) * clampedSize;
    return { items: rows.slice(start, start + clampedSize), total };
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
