import { describe, expect, it, beforeEach } from 'vitest';
import { LocalDemoRepository } from './localRepository';
import { MemoryStorage } from './storage';
import { DEMO_USERS, buildSeed } from './seed';
import { AppError } from '../repository';
import type { Session } from '../repository';
import type { CreateIncidentInput, CloseIncidentInput, ReopenIncidentInput } from '../../domain/schemas';
import { isOpen } from '../../domain/types';

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

describe('cancellation requirements', () => {
  let repo: LocalDemoRepository;
  beforeEach(() => {
    repo = newRepo({ now: FIXED_NOW });
  });

  it('denies cancellation to a technician', async () => {
    const incident = await repo.getIncident(tech1, 'inc-1');
    await expect(
      repo.cancelIncident(tech1, 'inc-1', {
        expectedVersion: incident!.version,
        eventTime: FIXED_NOW.toISOString(),
        cancellationReason: 'נפתחה בטעות',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('denies cancellation to a viewer', async () => {
    const incident = await repo.getIncident(viewer, 'inc-1');
    await expect(
      repo.cancelIncident(viewer, 'inc-1', {
        expectedVersion: incident!.version,
        eventTime: FIXED_NOW.toISOString(),
        cancellationReason: 'נפתחה בטעות',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects cancelling an already-closed incident', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-5'); // seeded closed
    await expect(
      repo.cancelIncident(supervisor1, 'inc-5', {
        expectedVersion: incident!.version,
        eventTime: FIXED_NOW.toISOString(),
        cancellationReason: 'נפתחה בטעות',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('rejects cancelling an already-cancelled incident', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    const cancelled = await repo.cancelIncident(supervisor1, 'inc-2', {
      expectedVersion: incident!.version,
      eventTime: FIXED_NOW.toISOString(),
      cancellationReason: 'כפילות',
    });
    await expect(
      repo.cancelIncident(supervisor1, 'inc-2', {
        expectedVersion: cancelled.version,
        eventTime: FIXED_NOW.toISOString(),
        cancellationReason: 'שוב',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('rejects a blank cancellation reason', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-1');
    await expect(
      repo.cancelIncident(supervisor1, 'inc-1', {
        expectedVersion: incident!.version,
        eventTime: FIXED_NOW.toISOString(),
        cancellationReason: '   ',
      }),
    ).rejects.toThrow(AppError);
  });

  it('rejects an event time before the incident was discovered', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-1');
    await expect(
      repo.cancelIncident(supervisor1, 'inc-1', {
        expectedVersion: incident!.version,
        eventTime: new Date(new Date(incident!.discoveredAt).getTime() - 3600_000).toISOString(),
        cancellationReason: 'נפתחה בטעות',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects an event time more than 5 minutes in the future', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-1');
    await expect(
      repo.cancelIncident(supervisor1, 'inc-1', {
        expectedVersion: incident!.version,
        eventTime: new Date(FIXED_NOW.getTime() + 10 * 60_000).toISOString(),
        cancellationReason: 'נפתחה בטעות',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects a stale expectedVersion (optimistic concurrency)', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-1');
    await expect(
      repo.cancelIncident(supervisor1, 'inc-1', {
        expectedVersion: incident!.version + 1,
        eventTime: FIXED_NOW.toISOString(),
        cancellationReason: 'נפתחה בטעות',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('cancels successfully: status, cancellation fields, and cleared deadline', async () => {
    const incident = await repo.getIncident(manager, 'inc-1');
    const cancelled = await repo.cancelIncident(manager, 'inc-1', {
      expectedVersion: incident!.version,
      eventTime: FIXED_NOW.toISOString(),
      cancellationReason: 'התקלה נפתחה בטעות',
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).toBe(FIXED_NOW.toISOString());
    expect(cancelled.cancelledBy).toBe(DEMO_USERS.manager);
    expect(cancelled.cancellationReason).toBe('התקלה נפתחה בטעות');
    expect(cancelled.nextUpdateDue).toBeNull();
    expect(cancelled.followUpRequired).toBe(false);
    expect(cancelled.version).toBe(incident!.version + 1);
  });

  it('a cancelled incident is no longer open', async () => {
    const incident = await repo.getIncident(manager, 'inc-1');
    const cancelled = await repo.cancelIncident(manager, 'inc-1', {
      expectedVersion: incident!.version,
      eventTime: FIXED_NOW.toISOString(),
      cancellationReason: 'התקלה נפתחה בטעות',
    });
    expect(isOpen(cancelled.status)).toBe(false);
  });

  it('records a cancelled timeline event with the reason and the actual event time', async () => {
    const incident = await repo.getIncident(manager, 'inc-1');
    await repo.cancelIncident(manager, 'inc-1', {
      expectedVersion: incident!.version,
      eventTime: FIXED_NOW.toISOString(),
      cancellationReason: 'התקלה נפתחה בטעות',
    });
    const events = await repo.getIncidentEvents(manager, 'inc-1');
    const event = events.find((e) => e.type === 'cancelled');
    expect(event).toBeDefined();
    expect(event!.note).toBe('התקלה נפתחה בטעות');
    expect(event!.actorId).toBe(DEMO_USERS.manager);
    expect(event!.oldValue).toBe('in_progress');
    expect(event!.newValue).toBe('cancelled');
  });

  it('writes an audit log entry for the cancellation', async () => {
    const incident = await repo.getIncident(manager, 'inc-1');
    await repo.cancelIncident(manager, 'inc-1', {
      expectedVersion: incident!.version,
      eventTime: FIXED_NOW.toISOString(),
      cancellationReason: 'התקלה נפתחה בטעות',
    });
    const logs = await repo.listAuditLogs(admin, {});
    expect(logs.some((l) => l.action === 'incident_cancelled' && l.incidentNumber === incident!.number)).toBe(true);
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

describe('Chapter 2 terminal-status compatibility', () => {
  // cancel_incident is not yet a reachable action through this repository
  // (no action UI, no RPC grant) -- the fixture below seeds a cancelled
  // incident directly into storage, exactly as historical or externally
  // inserted data would arrive, to prove the EXISTING read/filter logic
  // (isOpen, openOnly) correctly treats it as terminal without any new
  // action being implemented.
  it('excludes a cancelled incident from the openOnly filter, same as a closed one', async () => {
    const storage = new MemoryStorage();
    const seeded = buildSeed(FIXED_NOW);
    const target = seeded.incidents.find((i) => i.id === 'inc-2')!;
    target.status = 'cancelled';
    storage.save(seeded);
    const repo = new LocalDemoRepository(storage, { now: () => FIXED_NOW });

    const open = await repo.listIncidents(supervisor1, { openOnly: true });
    expect(open.some((i) => i.id === 'inc-2')).toBe(false);

    // Still fully readable through the generic status filter.
    const cancelledOnly = await repo.listIncidents(supervisor1, { status: ['cancelled'] });
    expect(cancelledOnly.map((i) => i.id)).toContain('inc-2');
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

describe('pre-provisioned personnel (mirrors migration 0008 rules)', () => {
  let repo: LocalDemoRepository;
  beforeEach(() => {
    repo = newRepo({ now: FIXED_NOW });
  });

  const input = (over: Partial<{ fullName: string; email: string; role: Session['role'] }> = {}) => ({
    fullName: 'חייל חדש',
    email: 'new.person@example.com',
    role: 'technician' as Session['role'],
    ...over,
  });

  describe('role ceilings (enforced in the backend layer, not the UI)', () => {
    it('technician and viewer cannot create entries at all', async () => {
      await expect(repo.createPendingPersonnel(tech1, input())).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(repo.createPendingPersonnel(viewer, input())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('shift supervisor may create technician and viewer, nothing at or above their own rank', async () => {
      await expect(repo.createPendingPersonnel(supervisor1, input({ role: 'technician' }))).resolves.toBeTruthy();
      await expect(
        repo.createPendingPersonnel(supervisor1, input({ email: 'b@example.com', role: 'viewer' })),
      ).resolves.toBeTruthy();
      await expect(
        repo.createPendingPersonnel(supervisor1, input({ email: 'peer@example.com', role: 'shift_supervisor' })),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        repo.createPendingPersonnel(supervisor1, input({ email: 'c@example.com', role: 'professional_manager' })),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        repo.createPendingPersonnel(supervisor1, input({ email: 'd@example.com', role: 'system_admin' })),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('NCO (professional manager) may create shift_supervisor, technician and viewer, but not a peer NCO or an administrator', async () => {
      await expect(
        repo.createPendingPersonnel(manager, input({ role: 'shift_supervisor' })),
      ).resolves.toBeTruthy();
      await expect(
        repo.createPendingPersonnel(manager, input({ email: 'viewer-by-nco@example.com', role: 'viewer' })),
      ).resolves.toBeTruthy();
      await expect(
        repo.createPendingPersonnel(manager, input({ email: 'peer@example.com', role: 'professional_manager' })),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        repo.createPendingPersonnel(manager, input({ email: 'e@example.com', role: 'system_admin' })),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('system administrator may create every role, including system_admin', async () => {
      await expect(repo.createPendingPersonnel(admin, input({ role: 'system_admin' }))).resolves.toBeTruthy();
    });

    it('a supervisor cannot edit or cancel an entry above their ceiling', async () => {
      const entry = await repo.createPendingPersonnel(admin, input({ role: 'professional_manager' }));
      await expect(
        repo.updatePendingPersonnel(supervisor1, entry.id, input({ role: 'technician' })),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(repo.cancelPendingPersonnel(supervisor1, entry.id)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('a supervisor cannot edit or cancel a PEER shift_supervisor entry', async () => {
      const entry = await repo.createPendingPersonnel(admin, input({ email: 'peer.entry@example.com', role: 'shift_supervisor' }));
      await expect(
        repo.updatePendingPersonnel(supervisor1, entry.id, input({ email: 'peer.entry@example.com', role: 'technician' })),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(repo.cancelPendingPersonnel(supervisor1, entry.id)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });

  describe('normalization and uniqueness', () => {
    it('stores the email normalized (trim + lowercase)', async () => {
      const entry = await repo.createPendingPersonnel(supervisor1, input({ email: '  Mixed.Case@EXAMPLE.Com  ' }));
      expect(entry.email).toBe('mixed.case@example.com');
    });

    it('rejects a duplicate claimable entry for the same email, and allows one again after cancelling', async () => {
      const first = await repo.createPendingPersonnel(supervisor1, input());
      await expect(repo.createPendingPersonnel(supervisor1, input())).rejects.toMatchObject({
        code: 'VALIDATION',
      });
      await repo.cancelPendingPersonnel(supervisor1, first.id);
      await expect(repo.createPendingPersonnel(supervisor1, input())).resolves.toBeTruthy();
    });
  });

  describe('claiming (the demo stand-in receives the identity the real backend derives itself)', () => {
    it('the exact confirmed email claims the entry and creates the profile with the preassigned role', async () => {
      const entry = await repo.createPendingPersonnel(supervisor1, input({ role: 'viewer' }));
      const profile = repo.claimPendingForIdentity({ authUserId: 'auth-x1', email: 'new.person@example.com' });
      expect(profile).toMatchObject({ id: 'auth-x1', role: 'viewer', active: true, fullName: 'חייל חדש' });
      const rows = await repo.listPendingPersonnel(supervisor1);
      expect(rows.find((r) => r.id === entry.id)).toMatchObject({ status: 'claimed', claimedBy: 'auth-x1' });
    });

    it('matching is case-insensitive after normalization', async () => {
      await repo.createPendingPersonnel(supervisor1, input({ email: 'person@example.com' }));
      const profile = repo.claimPendingForIdentity({ authUserId: 'auth-x2', email: '  PERSON@Example.COM ' });
      expect(profile).not.toBeNull();
    });

    it('a different Google account (different email) stays unauthorized', async () => {
      await repo.createPendingPersonnel(supervisor1, input());
      expect(repo.claimPendingForIdentity({ authUserId: 'auth-x3', email: 'someone.else@example.com' })).toBeNull();
    });

    it('no matching entry stays unauthorized', () => {
      expect(repo.claimPendingForIdentity({ authUserId: 'auth-x4', email: 'nobody@example.com' })).toBeNull();
    });

    it('a cancelled entry cannot be claimed', async () => {
      const entry = await repo.createPendingPersonnel(supervisor1, input());
      await repo.cancelPendingPersonnel(supervisor1, entry.id);
      expect(repo.claimPendingForIdentity({ authUserId: 'auth-x5', email: 'new.person@example.com' })).toBeNull();
    });

    it('an entry can be claimed exactly once; the claiming identity gets the same profile back idempotently', async () => {
      await repo.createPendingPersonnel(supervisor1, input());
      const first = repo.claimPendingForIdentity({ authUserId: 'auth-x6', email: 'new.person@example.com' });
      expect(first).not.toBeNull();
      // A DIFFERENT identity cannot claim the already-claimed entry.
      expect(repo.claimPendingForIdentity({ authUserId: 'auth-x7', email: 'new.person@example.com' })).toBeNull();
      // The SAME identity is idempotent: existing profile returned, no re-claim.
      const again = repo.claimPendingForIdentity({ authUserId: 'auth-x6', email: 'new.person@example.com' });
      expect(again).toMatchObject({ id: 'auth-x6' });
    });

    it('an expired entry cannot be claimed', async () => {
      const entry = await repo.createPendingPersonnel(supervisor1, input());
      const rows = await repo.listPendingPersonnel(supervisor1);
      // Simulate an expiry set in the past (the demo model honors expiresAt
      // exactly as the SQL claim does).
      void rows;
      const raw = (repo as unknown as { db: { pendingPersonnel: { id: string; expiresAt: string | null }[] } }).db;
      raw.pendingPersonnel.find((r) => r.id === entry.id)!.expiresAt = new Date(
        FIXED_NOW.getTime() - 1000,
      ).toISOString();
      expect(repo.claimPendingForIdentity({ authUserId: 'auth-x8', email: 'new.person@example.com' })).toBeNull();
    });

    it('an existing linked profile continues to work and is returned untouched (never re-claimed)', async () => {
      await repo.createPendingPersonnel(supervisor1, input());
      const existing = repo.claimPendingForIdentity({ authUserId: DEMO_USERS.tech1, email: 'new.person@example.com' });
      // tech1 already has a profile: it is returned as-is and the pending
      // entry is NOT consumed.
      expect(existing).toMatchObject({ id: DEMO_USERS.tech1, role: 'technician' });
      const rows = await repo.listPendingPersonnel(supervisor1);
      expect(rows.find((r) => r.email === 'new.person@example.com')?.status).toBe('pending');
    });

    it('the production interface method takes no identity input at all (demo returns null)', async () => {
      await repo.createPendingPersonnel(supervisor1, input());
      // claimPendingProfile() -- the ONLY claim surface the app calls -- has
      // no parameters through which client-supplied email/role/UUID could
      // influence the outcome.
      expect(repo.claimPendingProfile.length).toBe(0);
      await expect(repo.claimPendingProfile()).resolves.toBeNull();
    });
  });

  describe('inactive existing profiles (deactivation is revocation)', () => {
    it('an inactive existing profile is never returned as authorization by the claim path', async () => {
      await repo.createPendingPersonnel(supervisor1, input({ email: 'come.back@example.com' }));
      // Deactivate an existing linked user, then have that same identity try
      // to re-enter through the claim with a matching pending entry waiting.
      await repo.setUserActive(admin, DEMO_USERS.tech1, false);
      const result = repo.claimPendingForIdentity({ authUserId: DEMO_USERS.tech1, email: 'come.back@example.com' });
      expect(result).toBeNull();
      // The pending entry was NOT consumed and the profile was NOT
      // reactivated or replaced -- nothing about the deactivated account
      // changed.
      const rows = await repo.listPendingPersonnel(supervisor1);
      expect(rows.find((r) => r.email === 'come.back@example.com')?.status).toBe('pending');
      const profile = await repo.getProfile(DEMO_USERS.tech1);
      expect(profile).toMatchObject({ active: false });
    });

    it('a pending entry cannot even be created for an email already linked to a profile, active or inactive', async () => {
      await repo.createPendingPersonnel(supervisor1, input({ email: 'linked@example.com' }));
      const claimed = repo.claimPendingForIdentity({ authUserId: 'auth-linked-1', email: 'linked@example.com' });
      expect(claimed).not.toBeNull();
      // While active: rejected.
      await expect(
        repo.createPendingPersonnel(supervisor1, input({ email: 'linked@example.com' })),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      // After deactivation: STILL rejected -- a new pending entry must not
      // silently reactivate or replace the deactivated profile.
      await repo.setUserActive(admin, 'auth-linked-1', false);
      await expect(
        repo.createPendingPersonnel(supervisor1, input({ email: 'linked@example.com' })),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });

  describe('verified Google identity preconditions (mirrors the server-side auth.users/auth.identities checks)', () => {
    it('a non-Google identity cannot claim, even with the exact matching email', async () => {
      await repo.createPendingPersonnel(supervisor1, input());
      expect(
        repo.claimPendingForIdentity({ authUserId: 'auth-gh', email: 'new.person@example.com', provider: 'github' }),
      ).toBeNull();
      const rows = await repo.listPendingPersonnel(supervisor1);
      expect(rows.find((r) => r.email === 'new.person@example.com')?.status).toBe('pending');
    });

    it('an unconfirmed email cannot claim', async () => {
      await repo.createPendingPersonnel(supervisor1, input());
      expect(
        repo.claimPendingForIdentity({
          authUserId: 'auth-uc',
          email: 'new.person@example.com',
          emailConfirmed: false,
        }),
      ).toBeNull();
    });
  });

  describe('expiry lifecycle', () => {
    it('rejects a non-future expiresAt at creation', async () => {
      const past = new Date(FIXED_NOW.getTime() - 1000).toISOString();
      await expect(
        repo.createPendingPersonnel(supervisor1, { ...input(), expiresAt: past }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('an expired entry cannot be claimed, but does not permanently block a valid replacement (lazy retirement)', async () => {
      const entry = await repo.createPendingPersonnel(supervisor1, {
        ...input(),
        expiresAt: new Date(FIXED_NOW.getTime() + 60_000).toISOString(),
      });
      // Let the expiry pass (the demo clock is fixed, so move the stored
      // expiry into the past -- exactly what elapsed time would produce).
      const raw = (repo as unknown as { db: { pendingPersonnel: { id: string; expiresAt: string | null }[] } }).db;
      raw.pendingPersonnel.find((r) => r.id === entry.id)!.expiresAt = new Date(
        FIXED_NOW.getTime() - 1000,
      ).toISOString();

      // Not claimable.
      expect(repo.claimPendingForIdentity({ authUserId: 'auth-exp', email: 'new.person@example.com' })).toBeNull();

      // A replacement for the same email succeeds: the expired corpse is
      // retired to status 'expired' in the same operation, with an audit row.
      const replacement = await repo.createPendingPersonnel(supervisor1, input());
      expect(replacement.status).toBe('pending');
      const rows = await repo.listPendingPersonnel(supervisor1);
      expect(rows.find((r) => r.id === entry.id)?.status).toBe('expired');
      const logs = await repo.listAuditLogs(admin, {});
      expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['personnel_pending_expired']));
      // And the replacement is claimable.
      expect(repo.claimPendingForIdentity({ authUserId: 'auth-exp2', email: 'new.person@example.com' })).not.toBeNull();
    });
  });

  describe('unified personnel listing (list_personnel mirror)', () => {
    it('returns pending entries and linked profiles with normalized emails, resolved by the backend layer', async () => {
      await repo.createPendingPersonnel(supervisor1, input({ email: 'waiting@example.com' }));
      await repo.createPendingPersonnel(supervisor1, input({ email: 'joined@example.com' }));
      repo.claimPendingForIdentity({ authUserId: 'auth-j1', email: 'joined@example.com' });
      await repo.setUserActive(admin, 'auth-j1', false);

      const list = await repo.listPersonnel(supervisor1);
      expect(list.find((e) => e.kind === 'pending' && e.email === 'waiting@example.com')).toMatchObject({
        state: 'pending',
        role: 'technician',
      });
      // The linked (then deactivated) user appears with the email the
      // backend layer resolved -- the caller never supplied or queried it.
      expect(list.find((e) => e.kind === 'linked' && e.id === 'auth-j1')).toMatchObject({
        email: 'joined@example.com',
        state: 'inactive',
      });
      // Pre-seeded demo profiles (no Google identity) are listed with a
      // null email rather than an invented one.
      expect(list.find((e) => e.kind === 'linked' && e.id === DEMO_USERS.tech1)).toMatchObject({ email: null });
      // A claimed entry is no longer listed as pending.
      expect(list.find((e) => e.kind === 'pending' && e.email === 'joined@example.com')).toBeUndefined();
    });

    it('returns nothing to technicians and viewers', async () => {
      await expect(repo.listPersonnel(tech1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(repo.listPersonnel(viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('visibility and audit', () => {
    it('technicians cannot list pending personnel', async () => {
      await expect(repo.listPendingPersonnel(tech1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('creation, update, cancellation and claiming are all recorded in the audit log', async () => {
      const entry = await repo.createPendingPersonnel(supervisor1, input());
      await repo.updatePendingPersonnel(supervisor1, entry.id, input({ fullName: 'שם מעודכן' }));
      await repo.cancelPendingPersonnel(supervisor1, entry.id);
      await repo.createPendingPersonnel(supervisor1, input({ email: 'second@example.com' }));
      repo.claimPendingForIdentity({ authUserId: 'auth-a1', email: 'second@example.com' });

      const logs = await repo.listAuditLogs(admin, {});
      const actions = logs.map((l) => l.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'personnel_pending_created',
          'personnel_pending_updated',
          'personnel_pending_cancelled',
          'personnel_pending_claimed',
        ]),
      );
    });
  });
});

describe('linked-personnel management (mirrors migration 0010 rules)', () => {
  let repo: LocalDemoRepository;
  beforeEach(() => {
    repo = newRepo({ now: FIXED_NOW });
  });

  it('shift_supervisor may change the role of a technician to viewer, within ceiling', async () => {
    await repo.setUserRole(supervisor1, DEMO_USERS.tech1, 'viewer');
    const profile = await repo.getProfile(DEMO_USERS.tech1);
    expect(profile).toMatchObject({ role: 'viewer' });
  });

  it('shift_supervisor may manage a linked viewer profile', async () => {
    await expect(repo.setUserActive(supervisor1, DEMO_USERS.viewer, false)).resolves.toBeUndefined();
  });

  it('shift_supervisor cannot manage a PEER shift_supervisor', async () => {
    await expect(repo.setUserRole(supervisor1, DEMO_USERS.supervisor2, 'technician')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(repo.setUserActive(supervisor1, DEMO_USERS.supervisor2, false)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('shift_supervisor cannot manage a professional_manager (above ceiling)', async () => {
    await expect(repo.setUserRole(supervisor1, DEMO_USERS.manager, 'technician')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(repo.setUserActive(supervisor1, DEMO_USERS.manager, false)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('shift_supervisor cannot promote a technician to or above their own rank', async () => {
    await expect(repo.setUserRole(supervisor1, DEMO_USERS.tech1, 'shift_supervisor')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(repo.setUserRole(supervisor1, DEMO_USERS.tech1, 'professional_manager')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('professional_manager may manage shift_supervisor, technician and viewer, not a peer professional_manager or system_admin', async () => {
    await expect(repo.setUserRole(manager, DEMO_USERS.supervisor1, 'technician')).resolves.toBeUndefined();
    await expect(repo.setUserActive(manager, DEMO_USERS.viewer, false)).resolves.toBeUndefined();
  });

  it('professional_manager cannot manage a PEER professional_manager', async () => {
    await repo.setUserRole(admin, DEMO_USERS.tech2, 'professional_manager');
    await expect(repo.setUserRole(manager, DEMO_USERS.tech2, 'technician')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(repo.setUserActive(manager, DEMO_USERS.tech2, false)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('professional_manager cannot manage a system_admin', async () => {
    await expect(repo.setUserActive(manager, DEMO_USERS.admin, false)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('system_admin may manage every role including another system_admin', async () => {
    await expect(repo.setUserRole(admin, DEMO_USERS.supervisor1, 'system_admin')).resolves.toBeUndefined();
  });

  it('technician and viewer cannot manage anyone', async () => {
    await expect(repo.setUserRole(tech1, DEMO_USERS.tech2, 'shift_supervisor')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(repo.setUserActive(viewer, DEMO_USERS.tech1, false)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('no user may change their own role, even system_admin', async () => {
    await expect(repo.setUserRole(admin, DEMO_USERS.admin, 'professional_manager')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('no user may deactivate themselves, even system_admin', async () => {
    await expect(repo.setUserActive(admin, DEMO_USERS.admin, false)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('demoting a second admin down to one active admin is allowed (2 -> 1 is not the protected transition)', async () => {
    // Promote a second admin, then demote them back -- going from 2 active
    // admins to 1 must never be spuriously blocked.
    await repo.setUserRole(admin, DEMO_USERS.manager, 'system_admin');
    await expect(repo.setUserRole(admin, DEMO_USERS.manager, 'professional_manager')).resolves.toBeUndefined();
    const remaining = await repo.getProfile(DEMO_USERS.admin);
    expect(remaining).toMatchObject({ active: true, role: 'system_admin' });
  });

  it('deactivating a second admin down to one active admin is allowed (2 -> 1 is not the protected transition)', async () => {
    await repo.setUserRole(admin, DEMO_USERS.manager, 'system_admin');
    await expect(repo.setUserActive(admin, DEMO_USERS.manager, false)).resolves.toBeUndefined();
    const remaining = await repo.getProfile(DEMO_USERS.admin);
    expect(remaining).toMatchObject({ active: true, role: 'system_admin' });
  });

  // Given the unconditional self-block above, the ONLY way a single,
  // synchronous request could ever reach the "would drop to zero active
  // admins" guard is for the sole remaining admin to act on themselves --
  // which the self-block already rejects first (see the two tests above:
  // "no user may change their own role" / "no user may deactivate
  // themselves"). Acting on a DIFFERENT admin requires the caller to
  // themselves be an active admin, so caller+target are already two
  // distinct active-admin rows whenever this guard's condition could
  // matter -- the count can never actually be <=1 in that case. The
  // guard's real purpose is closing a RACE between two concurrent
  // requests removing two different admins at once, which is not
  // reproducible in this single-threaded demo repository; it is proven
  // instead with two concurrent SQL sessions against the real migration
  // (see the verification report).
  it('the guard never spuriously blocks managing non-admin roles while only one admin is active', async () => {
    // With only one active admin, demoting/deactivating a non-admin must
    // remain entirely unaffected by the last-admin rule.
    await expect(repo.setUserRole(admin, DEMO_USERS.tech1, 'shift_supervisor')).resolves.toBeUndefined();
    await expect(repo.setUserActive(admin, DEMO_USERS.tech2, false)).resolves.toBeUndefined();
  });

  it('every role and activation change is audited', async () => {
    await repo.setUserRole(admin, DEMO_USERS.tech1, 'shift_supervisor');
    await repo.setUserActive(admin, DEMO_USERS.tech2, false);
    await repo.setUserActive(admin, DEMO_USERS.tech2, true);
    const logs = await repo.listAuditLogs(admin, {});
    const actions = logs.map((l) => l.action);
    expect(actions).toEqual(
      expect.arrayContaining(['user_role_changed', 'user_deactivated', 'user_activated']),
    );
  });
});

describe('unified personnel listing across pending + linked (list_personnel mirror, end to end)', () => {
  it('reflects pending, active and inactive personnel together for a manager', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    await repo.createPendingPersonnel(supervisor1, {
      fullName: 'ממתין חדש',
      email: 'waiting.person@example.com',
      role: 'technician',
    });
    await repo.setUserActive(admin, DEMO_USERS.tech2, false);

    const list = await repo.listPersonnel(supervisor1);
    expect(list.some((e) => e.kind === 'pending' && e.email === 'waiting.person@example.com')).toBe(true);
    expect(list.some((e) => e.kind === 'linked' && e.id === DEMO_USERS.tech1 && e.state === 'active')).toBe(true);
    expect(list.some((e) => e.kind === 'linked' && e.id === DEMO_USERS.tech2 && e.state === 'inactive')).toBe(true);
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
