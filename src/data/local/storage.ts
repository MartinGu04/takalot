// Persistence for demo mode. localStorage in the browser, in-memory in tests.
import type {
  AppNotification,
  AuditLog,
  Incident,
  IncidentCauseAssessment,
  IncidentClosureClassification,
  IncidentEvent,
  IncidentTreatmentAction,
  IncidentUpdate,
  LocationRecord,
  PendingPersonnel,
  Profile,
  SystemRecord,
} from '../../domain/types';
import type { PolicyFlags } from '../../domain/permissions';
import type { AnalyticsModuleKey } from '../../domain/analyticsPreferences';

export interface StoredNotification extends AppNotification {
  dedupeKey?: string;
  /** Set once the recipient clears it (נקה הכל) -- see 0048_notification_dismissal.
   *  Absent/null on every row from a database persisted before this feature,
   *  which is exactly the correct "not dismissed" default -- no backfill needed. */
  dismissedAt?: string | null;
}

/** Canonical storage shape, mirroring incident_relations (migration 0049)
 *  exactly: one row per unordered pair, incidentAId < incidentBId always
 *  (LocalDemoRepository enforces this the same way the SQL CHECK
 *  constraint does). "The other side" is resolved at READ time
 *  (getIncidentRelations), never stored twice. */
export interface StoredIncidentRelation {
  id: string;
  incidentAId: string;
  incidentBId: string;
  createdBy: string;
  createdAt: string;
  operationId: string;
}

export interface DemoDatabase {
  seededAt: string | null;
  /** 1: reference-data ordering (displayOrder) backfilled. 2: reference-data
   *  category backfilled. Older demo databases are backfilled in place --
   *  see LocalDemoRepository's backfillReferenceDataOrder/
   *  backfillReferenceDataCategory. */
  referenceDataSchemaVersion?: 1 | 2;
  profiles: Profile[];
  systems: SystemRecord[];
  locations: LocationRecord[];
  incidents: Incident[];
  incidentUpdates: IncidentUpdate[];
  incidentEvents: IncidentEvent[];
  /** Optional for databases persisted before this feature existed --
   *  LocalDemoRepository treats a missing array as empty, exactly like
   *  pendingPersonnel below. */
  incidentCauseAssessments?: IncidentCauseAssessment[];
  incidentTreatmentActions?: IncidentTreatmentAction[];
  incidentClosures?: IncidentClosureClassification[];
  /** Optional for databases persisted before this feature existed -- same
   *  backward-compat pattern as incidentCauseAssessments etc. above. */
  incidentRelations?: StoredIncidentRelation[];
  notifications: StoredNotification[];
  auditLogs: AuditLog[];
  /** Optional for databases persisted before 0008's model existed. */
  pendingPersonnel?: PendingPersonnel[];
  /** Per-user analytics module-visibility preference ("התאמת התצוגה"), keyed
   *  by userId -- mirrors user_analytics_preferences (migration 0052).
   *  Absence of a key (or the whole map, for a database persisted before
   *  this feature existed) means "use the role default," exactly like the
   *  hosted table's "no row" state -- see src/domain/analyticsPreferences.ts. */
  analyticsPreferences?: Record<string, AnalyticsModuleKey[]>;
  sequences: Record<string, number>; // year -> last allocated number
  policy: PolicyFlags;
}

export function emptyDatabase(): DemoDatabase {
  return {
    seededAt: null,
    referenceDataSchemaVersion: 2,
    profiles: [],
    systems: [],
    locations: [],
    incidents: [],
    incidentUpdates: [],
    incidentEvents: [],
    incidentCauseAssessments: [],
    incidentTreatmentActions: [],
    incidentClosures: [],
    incidentRelations: [],
    notifications: [],
    auditLogs: [],
    pendingPersonnel: [],
    analyticsPreferences: {},
    sequences: {},
    policy: { allowSupervisorReopen: false, viewerExportUserIds: [] },
  };
}

export interface DemoStorage {
  load(): DemoDatabase | null;
  save(db: DemoDatabase): void;
  clear(): void;
}

const STORAGE_KEY = 'takalot-demo-db-v1';

export class BrowserStorage implements DemoStorage {
  load(): DemoDatabase | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as DemoDatabase;
    } catch {
      return null;
    }
  }
  save(db: DemoDatabase): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }
  clear(): void {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export class MemoryStorage implements DemoStorage {
  private db: DemoDatabase | null = null;
  load(): DemoDatabase | null {
    return this.db ? (JSON.parse(JSON.stringify(this.db)) as DemoDatabase) : null;
  }
  save(db: DemoDatabase): void {
    this.db = JSON.parse(JSON.stringify(db)) as DemoDatabase;
  }
  clear(): void {
    this.db = null;
  }
}
