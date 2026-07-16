// Persistence for demo mode. localStorage in the browser, in-memory in tests.
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
  SystemRecord,
} from '../../domain/types';
import type { PolicyFlags } from '../../domain/permissions';

export interface StoredNotification extends AppNotification {
  dedupeKey?: string;
}

export interface DemoDatabase {
  seededAt: string | null;
  profiles: Profile[];
  systems: SystemRecord[];
  locations: LocationRecord[];
  incidents: Incident[];
  incidentUpdates: IncidentUpdate[];
  incidentEvents: IncidentEvent[];
  handovers: Handover[];
  handoverItems: HandoverItem[];
  handoverAddenda: HandoverAddendum[];
  notifications: StoredNotification[];
  auditLogs: AuditLog[];
  sequences: Record<string, number>; // year -> last allocated number
  policy: PolicyFlags;
}

export function emptyDatabase(): DemoDatabase {
  return {
    seededAt: null,
    profiles: [],
    systems: [],
    locations: [],
    incidents: [],
    incidentUpdates: [],
    incidentEvents: [],
    handovers: [],
    handoverItems: [],
    handoverAddenda: [],
    notifications: [],
    auditLogs: [],
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
