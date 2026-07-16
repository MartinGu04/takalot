import { describe, expect, it, beforeEach } from 'vitest';
import { LocalDemoRepository } from './localRepository';
import { MemoryStorage } from './storage';
import { DEMO_USERS } from './seed';
import { AppError } from '../repository';
import type { Session } from '../repository';
import type { CreateIncidentInput, CloseIncidentInput, ReopenIncidentInput } from '../../domain/schemas';

function session(userId: string, role: Session['role']): Session {
  return { userId, role };
}

const FIXED_NOW = new Date('2026-07-16T10:00:00.000Z');
const admin = session(DEMO_USERS.admin, 'system_admin');
const supervisor1 = session(DEMO_USERS.supervisor1, 'shift_supervisor');
const supervisor2 = session(DEMO_USERS.supervisor2, 'shift_supervisor');
const manager = session(DEMO_USERS.manager, 'professional_manager');
const tech1 = session(DEMO_USERS.tech1, 'technician');
const tech2 = session(DEMO_USERS.tech2, 'technician');
const viewer = session(DEMO_USERS.viewer, 'viewer');

function newRepo(clock: { now: Date }) {
  return new LocalDemoRepository(new MemoryStorage(), { now: () => clock.now });
}

function baseCreateInput(overrides: Partial<CreateIncidentInput> = {}): CreateIncidentInput {
  return {
    systemId: 'sys-alpha',
    locationId: 'loc-1',
    discoveredAt: FIXED_NOW.toISOString(),
    description: 'תקלה לצורך בדיקה',
    severity: 'medium',
    operationalImpact: 'השפעה מבצעית לצורך בדיקה',
    actionsTaken: 'נבדק ראשונית',
    status: 'new',
    ownerUserId: DEMO_USERS.tech1,
    ownerExternalName: null,
    nextUpdateDue: new Date(FIXED_NOW.getTime() + 4 * 3600_000).toISOString(),
    noDeadlineReason: null,
    reportedToOps: 'no',
    ...overrides,
  };
}

describe('incident numbering atomicity and yearly reset', () => {
  it('allocates unique, sequentially increasing numbers under concurrent creation', async () => {
    const clock = { now: FIXED_NOW };
    const repo = newRepo(clock);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => repo.createIncident(supervisor1, baseCreateInput())),
    );
    const numbers = results.map((r) => r.number);
    expect(new Set(numbers).size).toBe(5); // all unique
    const suffixes = numbers.map((n) => Number(n.split('-')[1])).sort((a, b) => a - b);
    // seed already allocated 7 numbers in 2026, so these five continue 8..12
    expect(suffixes).toEqual([8, 9, 10, 11, 12]);
  });

  it('resets the sequence to 001 for a new calendar year (Asia/Jerusalem)', async () => {
    const clock = { now: new Date('2026-12-31T20:00:00.000Z') }; // still Dec 31 in Jerusalem (UTC+2 in winter)
    const repo = newRepo(clock);
    const last2026 = await repo.createIncident(supervisor1, baseCreateInput());
    expect(last2026.number.startsWith('2026-')).toBe(true);

    clock.now = new Date('2027-01-01T05:00:00.000Z'); // clearly 2027 in Jerusalem
    const first2027 = await repo.createIncident(supervisor1, baseCreateInput());
    expect(first2027.number).toBe('2027-001');
  });
});

describe('closure requirements', () => {
  let repo: LocalDemoRepository;
  beforeEach(() => {
    repo = newRepo({ now: FIXED_NOW });
  });

  it('rejects closure without root cause or resolution', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-1');
    await expect(
      repo.closeIncident(supervisor1, 'inc-1', {
        expectedVersion: incident!.version,
        rootCause: '',
        resolution: '',
        readiness: 'full',
        followUpNotes: '',
        reportedToOps: 'no',
      } as CloseIncidentInput),
    ).rejects.toThrow(AppError);
  });

  it('requires follow-up notes when readiness is not full', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    await expect(
      repo.closeIncident(supervisor1, 'inc-2', {
        expectedVersion: incident!.version,
        rootCause: 'תקלת חומרה',
        resolution: 'הוחלף רכיב',
        readiness: 'partial',
        followUpNotes: '',
        reportedToOps: 'no',
      } as CloseIncidentInput),
    ).rejects.toThrow(AppError);
  });

  it('closes successfully with full readiness and clears the next-update deadline', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    const closed = await repo.closeIncident(supervisor1, 'inc-2', {
      expectedVersion: incident!.version,
      rootCause: 'תקלת חומרה בכרטיס התקשורת',
      resolution: 'הוחלף הכרטיס ואומתה תקינות',
      readiness: 'full',
      followUpNotes: '',
      reportedToOps: 'yes',
    });
    expect(closed.status).toBe('closed');
    expect(closed.followUpRequired).toBe(false);
    expect(closed.nextUpdateDue).toBeNull();
    expect(closed.closedBy).toBe(DEMO_USERS.supervisor1);
  });

  it('marks follow_up_required automatically for partial readiness', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-3');
    const closed = await repo.closeIncident(supervisor1, 'inc-3', {
      expectedVersion: incident!.version,
      rootCause: 'רכיב פגום',
      resolution: 'הותקן פתרון זמני',
      readiness: 'partial',
      followUpNotes: 'להתקין רכיב קבוע בהמשך',
      reportedToOps: 'no',
    });
    expect(closed.followUpRequired).toBe(true);
  });

  it('denies closure to a technician', async () => {
    const incident = await repo.getIncident(tech1, 'inc-1');
    await expect(
      repo.closeIncident(tech1, 'inc-1', {
        expectedVersion: incident!.version,
        rootCause: 'x',
        resolution: 'y',
        readiness: 'full',
        followUpNotes: '',
        reportedToOps: 'no',
      }),
    ).rejects.toThrow(AppError);
  });

  it('rejects closing an already-closed incident', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-5'); // seeded closed
    await expect(
      repo.closeIncident(supervisor1, 'inc-5', {
        expectedVersion: incident!.version,
        rootCause: 'x',
        resolution: 'y',
        readiness: 'full',
        followUpNotes: '',
        reportedToOps: 'no',
      }),
    ).rejects.toThrow(AppError);
  });
});

describe('reopening requirements', () => {
  let repo: LocalDemoRepository;
  beforeEach(() => {
    repo = newRepo({ now: FIXED_NOW });
  });

  it('rejects reopening a non-closed incident', async () => {
    const incident = await repo.getIncident(manager, 'inc-1');
    await expect(
      repo.reopenIncident(manager, 'inc-1', {
        expectedVersion: incident!.version,
        reason: 'סיבה',
        nextUpdateDue: new Date(FIXED_NOW.getTime() + 3600_000).toISOString(),
        ownerUserId: DEMO_USERS.tech1,
        ownerExternalName: null,
      }),
    ).rejects.toThrow(AppError);
  });

  it('denies shift_supervisor reopen by default policy', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-5');
    await expect(
      repo.reopenIncident(supervisor1, 'inc-5', {
        expectedVersion: incident!.version,
        reason: 'התופעה חזרה',
        nextUpdateDue: new Date(FIXED_NOW.getTime() + 3600_000).toISOString(),
        ownerUserId: DEMO_USERS.tech1,
        ownerExternalName: null,
      }),
    ).rejects.toThrow(AppError);
  });

  it('allows shift_supervisor reopen once policy explicitly grants it', async () => {
    repo.setPolicy({ allowSupervisorReopen: true });
    const incident = await repo.getIncident(supervisor1, 'inc-5');
    const reopened = await repo.reopenIncident(supervisor1, 'inc-5', {
      expectedVersion: incident!.version,
      reason: 'התופעה חזרה',
      nextUpdateDue: new Date(FIXED_NOW.getTime() + 3600_000).toISOString(),
      ownerUserId: DEMO_USERS.tech1,
      ownerExternalName: null,
    });
    expect(reopened.status).toBe('reopened');
  });

  it('allows professional_manager to reopen and requires reason + owner + next-update deadline', async () => {
    const incident = await repo.getIncident(manager, 'inc-5');
    const reopened = await repo.reopenIncident(manager, 'inc-5', {
      expectedVersion: incident!.version,
      reason: 'התגלה שהתקלה לא נפתרה במלואה',
      nextUpdateDue: new Date(FIXED_NOW.getTime() + 2 * 3600_000).toISOString(),
      ownerUserId: DEMO_USERS.tech2,
      ownerExternalName: null,
    } satisfies ReopenIncidentInput);
    expect(reopened.status).toBe('reopened');
    expect(reopened.ownerUserId).toBe(DEMO_USERS.tech2);
    expect(reopened.reopenCount).toBe(1);
    expect(reopened.closedAt).toBeNull();
    expect(reopened.nextUpdateDue).not.toBeNull();

    const events = await repo.getIncidentEvents(manager, 'inc-5');
    expect(events.some((e) => e.type === 'reopened')).toBe(true);
  });

  it('rejects reopening without a reason', async () => {
    const incident = await repo.getIncident(manager, 'inc-6');
    await expect(
      repo.reopenIncident(manager, 'inc-6', {
        expectedVersion: incident!.version,
        reason: '',
        nextUpdateDue: new Date(FIXED_NOW.getTime() + 3600_000).toISOString(),
        ownerUserId: DEMO_USERS.tech1,
        ownerExternalName: null,
      } as ReopenIncidentInput),
    ).rejects.toThrow(AppError);
  });
});

describe('technician update restrictions (backend enforced)', () => {
  let repo: LocalDemoRepository;
  beforeEach(() => {
    repo = newRepo({ now: FIXED_NOW });
  });

  it('allows a technician to add a technical update to their own assigned incident', async () => {
    const incident = await repo.getIncident(tech1, 'inc-1'); // owned by tech1 in seed
    const updated = await repo.technicianUpdate(tech1, 'inc-1', {
      expectedVersion: incident!.version,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'המשך בדיקה טכנית',
      findings: 'לא נמצא חדש',
      nextSteps: 'המשך מעקב',
    });
    expect(updated.version).toBe(incident!.version + 1);
  });

  it('denies a technician updating an incident assigned to a different technician', async () => {
    const incident = await repo.getIncident(tech2, 'inc-1'); // owned by tech1, not tech2
    await expect(
      repo.technicianUpdate(tech2, 'inc-1', {
        expectedVersion: incident!.version,
        eventTime: FIXED_NOW.toISOString(),
        actionsTaken: 'ניסיון גישה לתקלה של אחר',
        findings: '',
        nextSteps: '',
      }),
    ).rejects.toThrow(AppError);
  });

  it('denies a technician from performing a full update (protected fields)', async () => {
    const incident = await repo.getIncident(tech1, 'inc-1');
    await expect(
      repo.updateIncident(tech1, 'inc-1', {
        expectedVersion: incident!.version,
        eventTime: FIXED_NOW.toISOString(),
        actionsTaken: 'ניסיון עדכון מלא',
        findings: '',
        nextSteps: '',
        status: 'monitoring',
        severity: 'low',
        operationalImpact: 'שינוי לא מורשה',
        changeReason: '',
        ownerUserId: DEMO_USERS.tech1,
        ownerExternalName: null,
        nextUpdateDue: null,
        noDeadlineReason: 'x',
        reportedToOps: 'no',
      }),
    ).rejects.toThrow(AppError);
  });

  it('denies a technician from closing an incident', async () => {
    await expect(repo.acknowledgeIncident(tech1, 'inc-1', 1)).rejects.toThrow(AppError);
  });
});

describe('optimistic concurrency', () => {
  it('rejects an update carrying a stale expected version after a concurrent change', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    const staleVersion = incident!.version;

    // First writer succeeds.
    await repo.updateIncident(supervisor1, 'inc-2', {
      expectedVersion: staleVersion,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'עדכון ראשון',
      findings: '',
      nextSteps: '',
      status: incident!.status,
      severity: incident!.severity,
      operationalImpact: incident!.operationalImpact,
      changeReason: '',
      ownerUserId: incident!.ownerUserId,
      ownerExternalName: incident!.ownerExternalName,
      nextUpdateDue: incident!.nextUpdateDue,
      noDeadlineReason: incident!.noDeadlineReason,
      reportedToOps: incident!.reportedToOps,
    });

    // Second writer, still holding the stale version from before the first write, must be rejected.
    await expect(
      repo.updateIncident(supervisor2, 'inc-2', {
        expectedVersion: staleVersion,
        eventTime: FIXED_NOW.toISOString(),
        actionsTaken: 'עדכון שני על נתונים ישנים',
        findings: '',
        nextSteps: '',
        status: incident!.status,
        severity: incident!.severity,
        operationalImpact: incident!.operationalImpact,
        changeReason: '',
        ownerUserId: incident!.ownerUserId,
        ownerExternalName: incident!.ownerExternalName,
        nextUpdateDue: incident!.nextUpdateDue,
        noDeadlineReason: incident!.noDeadlineReason,
        reportedToOps: incident!.reportedToOps,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('handover creation and acceptance', () => {
  let repo: LocalDemoRepository;
  beforeEach(() => {
    repo = newRepo({ now: FIXED_NOW });
  });

  it('includes all open incidents and closed incidents with pending follow-up', async () => {
    const handover = await repo.createHandover(supervisor1, {
      toUserId: DEMO_USERS.supervisor2,
      generalNote: 'סיכום משמרת לבדיקה',
      itemNotes: {},
    });
    const full = await repo.getHandover(supervisor1, handover.id);
    const incidentIds = full!.items.map((i) => i.incidentId);
    expect(incidentIds).toContain('inc-1'); // open
    expect(incidentIds).toContain('inc-6'); // closed with pending follow-up
    expect(incidentIds).not.toContain('inc-5'); // closed, full readiness
  });

  it('rejects creating a handover to oneself', async () => {
    await expect(
      repo.createHandover(supervisor1, { toUserId: DEMO_USERS.supervisor1, generalNote: '', itemNotes: {} }),
    ).rejects.toThrow(AppError);
  });

  it('only the named incoming supervisor may accept, and only once', async () => {
    const handover = await repo.createHandover(supervisor1, {
      toUserId: DEMO_USERS.supervisor2,
      generalNote: '',
      itemNotes: {},
    });
    await expect(repo.acceptHandover(manager, handover.id)).rejects.toThrow(AppError);

    const accepted = await repo.acceptHandover(supervisor2, handover.id);
    expect(accepted.status).toBe('accepted');
    expect(accepted.acceptedBy).toBe(DEMO_USERS.supervisor2);

    await expect(repo.acceptHandover(supervisor2, handover.id)).rejects.toThrow(AppError);
  });
});

describe('filter behavior', () => {
  it('filters by severity', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const critical = await repo.listIncidents(supervisor1, { severity: ['critical'] });
    expect(critical.every((i) => i.severity === 'critical')).toBe(true);
    expect(critical.some((i) => i.id === 'inc-1')).toBe(true);
  });

  it('filters by overdue-only', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const overdue = await repo.listIncidents(supervisor1, { overdueOnly: true });
    expect(overdue.length).toBeGreaterThan(0);
    expect(overdue.some((i) => i.id === 'inc-1')).toBe(true);
    expect(overdue.some((i) => i.id === 'inc-2')).toBe(false);
  });

  it('filters closed-only for the archive', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const closed = await repo.listIncidents(supervisor1, { closedOnly: true });
    expect(closed.every((i) => i.status === 'closed')).toBe(true);
  });

  it('searches by free text across number, system, and description', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const bySystem = await repo.listIncidents(supervisor1, { search: 'אלפא' });
    expect(bySystem.length).toBeGreaterThan(0);
    const byNumber = await repo.listIncidents(supervisor1, { search: '2026-002' });
    expect(byNumber.map((i) => i.id)).toEqual(['inc-2']);
  });
});

describe('export permission enforcement', () => {
  it('allows export for shift_supervisor and system_admin', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    expect(await repo.canExport(supervisor1)).toBe(true);
    expect(await repo.canExport(admin)).toBe(true);
  });

  it('denies export for technician and default viewer', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    expect(await repo.canExport(tech1)).toBe(false);
    expect(await repo.canExport(viewer)).toBe(false);
    await expect(
      repo.recordExport(viewer, { exportType: 'incidents_csv', filtersDescription: '{}' }),
    ).rejects.toThrow(AppError);
  });

  it('records an audit entry for a permitted export', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    await repo.recordExport(supervisor1, { exportType: 'incidents_xlsx', filtersDescription: '{}' });
    const logs = await repo.listAuditLogs(admin, {});
    expect(logs.some((l) => l.action === 'export_generated')).toBe(true);
  });
});
