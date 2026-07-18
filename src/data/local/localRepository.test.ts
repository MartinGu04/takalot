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
    // seed already allocated 8 numbers in 2026, so these five continue 9..13
    expect(suffixes).toEqual([9, 10, 11, 12, 13]);
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
      reportedToOpsRecipient: 'אחמ״ש מוקד מבצעים',
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
      ownerUserId: DEMO_USERS.tech1,
      ownerExternalName: null,
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

describe('incomplete-readiness lifecycle', () => {
  let repo: LocalDemoRepository;
  beforeEach(() => {
    repo = newRepo({ now: FIXED_NOW });
  });

  it('keeps an incident active as "כשירות חלקית" instead of closing it when readiness is partial', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    const result = await repo.closeIncident(supervisor1, 'inc-2', {
      expectedVersion: incident!.version,
      rootCause: 'תקלת חומרה',
      resolution: 'הוחלף רכיב זמני',
      readiness: 'partial',
      followUpNotes: 'להזמין רכיב קבוע',
      ownerUserId: DEMO_USERS.tech2,
      ownerExternalName: null,
      reportedToOps: 'no',
    });
    expect(result.status).toBe('partial_readiness');
    expect(result.status).not.toBe('closed');
    expect(result.closedAt).toBeNull();
    expect(result.closedBy).toBeNull();
    expect(result.followUpRequired).toBe(true);
    expect(result.ownerUserId).toBe(DEMO_USERS.tech2);

    // Stays visible among active incidents, not closed/archived.
    const active = await repo.listIncidents(supervisor1, { openOnly: true });
    expect(active.some((i) => i.id === 'inc-2')).toBe(true);
  });

  it('keeps an incident active when readiness is "none" as well', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-3');
    const result = await repo.closeIncident(supervisor1, 'inc-3', {
      expectedVersion: incident!.version,
      rootCause: 'תקלת חומרה חמורה',
      resolution: 'טופל חלקית',
      readiness: 'none',
      followUpNotes: 'להמשיך טיפול',
      ownerUserId: DEMO_USERS.tech1,
      ownerExternalName: null,
      reportedToOps: 'no',
    });
    expect(result.status).toBe('partial_readiness');
    expect(result.closedAt).toBeNull();
  });

  it('requires a responsible owner when readiness is not full', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    await expect(
      repo.closeIncident(supervisor1, 'inc-2', {
        expectedVersion: incident!.version,
        rootCause: 'תקלת חומרה',
        resolution: 'הוחלף רכיב זמני',
        readiness: 'partial',
        followUpNotes: 'להזמין רכיב קבוע',
        reportedToOps: 'no',
      } as CloseIncidentInput),
    ).rejects.toThrow(AppError);
  });

  it('only closes the incident (status "נסגרה") when readiness is full', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    const result = await repo.closeIncident(supervisor1, 'inc-2', {
      expectedVersion: incident!.version,
      rootCause: 'תקלת חומרה',
      resolution: 'תוקנה במלואה',
      readiness: 'full',
      followUpNotes: '',
      reportedToOps: 'no',
    });
    expect(result.status).toBe('closed');
    expect(result.closedAt).not.toBeNull();
    expect(result.followUpRequired).toBe(false);
  });

  it('allows closing again for real once a partial-readiness incident reaches full readiness', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    const partial = await repo.closeIncident(supervisor1, 'inc-2', {
      expectedVersion: incident!.version,
      rootCause: 'תקלת חומרה',
      resolution: 'הוחלף רכיב זמני',
      readiness: 'partial',
      followUpNotes: 'להזמין רכיב קבוע',
      ownerUserId: DEMO_USERS.tech2,
      ownerExternalName: null,
      reportedToOps: 'no',
    });
    expect(partial.status).toBe('partial_readiness');

    const closed = await repo.closeIncident(supervisor1, 'inc-2', {
      expectedVersion: partial.version,
      rootCause: 'תקלת חומרה',
      resolution: 'הותקן רכיב קבוע ואומתה תקינות מלאה',
      readiness: 'full',
      followUpNotes: '',
      reportedToOps: 'no',
    });
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
  });
});

describe('reporting recipient', () => {
  let repo: LocalDemoRepository;
  beforeEach(() => {
    repo = newRepo({ now: FIXED_NOW });
  });

  it('requires a recipient only when reportedToOps is "yes"', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    await expect(
      repo.updateIncident(supervisor1, 'inc-2', {
        expectedVersion: incident!.version,
        eventTime: FIXED_NOW.toISOString(),
        actionsTaken: 'עדכון',
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
        reportedToOps: 'yes',
        reportedToOpsRecipient: '',
      }),
    ).rejects.toThrow(AppError);

    const withRecipient = await repo.updateIncident(supervisor1, 'inc-2', {
      expectedVersion: incident!.version,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'עדכון',
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
      reportedToOps: 'yes',
      reportedToOpsRecipient: 'אחמ״ש מוקד מבצעים',
    });
    expect(withRecipient.reportedToOpsRecipient).toBe('אחמ״ש מוקד מבצעים');

    // Not required, and cleared, when reportedToOps is "no".
    const cleared = await repo.updateIncident(supervisor1, 'inc-2', {
      expectedVersion: withRecipient.version,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'עדכון נוסף',
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
      reportedToOps: 'no',
      reportedToOpsRecipient: 'ערך שאמור להימחק',
    });
    expect(cleared.reportedToOpsRecipient).toBeNull();
  });

  it('records the recipient in a timeline event visible in incident history', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    await repo.updateIncident(supervisor1, 'inc-2', {
      expectedVersion: incident!.version,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'דווח למבצעים',
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
      reportedToOps: 'yes',
      reportedToOpsRecipient: 'אחמ״ש מוקד מבצעים',
    });
    const events = await repo.getIncidentEvents(supervisor1, 'inc-2');
    const recipientEvent = events.find((e) => e.type === 'reported_to_ops_change');
    expect(recipientEvent).toBeDefined();
    expect(recipientEvent!.newValue).toBe('אחמ״ש מוקד מבצעים');
    expect(recipientEvent!.actorId).toBe(DEMO_USERS.supervisor1);
    expect(recipientEvent!.serverTime).toBeTruthy();
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
      reportedToOpsRecipient: incident!.reportedToOpsRecipient,
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
        reportedToOpsRecipient: incident!.reportedToOpsRecipient,
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

  it('can be submitted with no general note and no individual incident notes', async () => {
    const handover = await repo.createHandover(supervisor1, {
      toUserId: DEMO_USERS.supervisor2,
      generalNote: '',
      itemNotes: {},
    });
    expect(handover.status).toBe('pending');
    const full = await repo.getHandover(supervisor1, handover.id);
    expect(full!.items.length).toBeGreaterThan(0);
    expect(full!.items.every((i) => i.note === '')).toBe(true);
  });

  it('preserves optional per-incident notes when supplied, leaving others blank', async () => {
    const handover = await repo.createHandover(supervisor1, {
      toUserId: DEMO_USERS.supervisor2,
      generalNote: 'הערה כללית',
      itemNotes: { 'inc-1': 'לתשומת לב מיוחדת בתחילת המשמרת' },
    });
    const full = await repo.getHandover(supervisor1, handover.id);
    const inc1Item = full!.items.find((i) => i.incidentId === 'inc-1');
    expect(inc1Item?.note).toBe('לתשומת לב מיוחדת בתחילת המשמרת');
    const otherItem = full!.items.find((i) => i.incidentId !== 'inc-1');
    expect(otherItem?.note).toBe('');
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

describe('active incidents page semantics', () => {
  it('openOnly excludes closed incidents but keeps reopened incidents', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const active = await repo.listIncidents(supervisor1, { openOnly: true });
    const ids = active.map((i) => i.id);
    // inc-5 and inc-6 are seeded as closed (inc-6 with incomplete readiness,
    // which belongs only in the archive and the dashboard's dedicated
    // section -- never in the active incidents list).
    expect(ids).not.toContain('inc-5');
    expect(ids).not.toContain('inc-6');
    expect(active.every((i) => i.status !== 'closed')).toBe(true);
    // inc-7 is seeded as reopened -- not closed, so it stays active.
    expect(ids).toContain('inc-7');
    expect(active.find((i) => i.id === 'inc-7')?.status).toBe('reopened');
  });

  it('applies the default operational priority order: critical/high overdue, other overdue, remaining critical/high, remaining active (newest discovery first within each tier)', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const active = await repo.listIncidents(supervisor1, { openOnly: true }, 'priority');
    // inc-1: critical, overdue -> tier 1 (critical/high overdue)
    // inc-2: high, not overdue -> tier 3 (remaining critical/high)
    // inc-3, inc-4, inc-7, inc-8: medium/low, not overdue -> tier 4 (remaining
    //   active), ordered by newest discovery time first: inc-4 > inc-3 > inc-8 > inc-7
    expect(active.map((i) => i.id)).toEqual(['inc-1', 'inc-2', 'inc-4', 'inc-3', 'inc-8', 'inc-7']);
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
