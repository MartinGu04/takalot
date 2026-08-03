import { describe, expect, it, beforeEach } from 'vitest';
import { LocalDemoRepository } from './localRepository';
import { MemoryStorage } from './storage';
import { DEMO_USERS, buildSeed } from './seed';
import { AppError } from '../repository';
import type { Session } from '../repository';
import type {
  CreateIncidentInput,
  CloseIncidentInput,
  ReopenIncidentInput,
  UpdateIncidentInput,
} from '../../domain/schemas';
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
    reportedToOps: 'no',
    reportedToComms: false,
    reportedToCommsRecipient: null,
    wisdomReported: false,
    wisdomIncidentNumber: null,
    note: '',
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
    // seed already allocated 9 numbers in 2026, so these five continue 10..14
    expect(suffixes).toEqual([10, 11, 12, 13, 14]);
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

// Chapter 2 creation-ownership requirements (mirrors create_incident's own
// database enforcement, migration 0019): a direct repository caller --
// bypassing IncidentCreatePage entirely -- must not be able to reach a
// state the real RPC would reject. assert_owner_valid/validateOwner itself
// is unchanged and stays nullable for update/assign/close/reopen.
describe('creation ownership requirements (Chapter 2, mirrors migration 0019)', () => {
  it('creates successfully with a valid active internal owner', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const incident = await repo.createIncident(supervisor1, baseCreateInput());
    expect(incident.ownerUserId).toBe(DEMO_USERS.tech1);
    expect(incident.ownerExternalName).toBeNull();
  });

  it('rejects external-owner-only creation (no internal owner) from a direct repository call', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    await expect(
      repo.createIncident(
        supervisor1,
        baseCreateInput({ ownerUserId: null, ownerExternalName: 'טכנאי מטעם ספק' }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects a missing owner entirely (both fields null) from a direct repository call', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    await expect(
      repo.createIncident(supervisor1, baseCreateInput({ ownerUserId: null, ownerExternalName: null })),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects supplying both an internal AND an external owner together from a direct repository call', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    await expect(
      repo.createIncident(
        supervisor1,
        baseCreateInput({ ownerUserId: DEMO_USERS.tech1, ownerExternalName: 'טכנאי מטעם ספק' }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects an inactive internal owner', async () => {
    const storage = new MemoryStorage();
    const seeded = buildSeed(FIXED_NOW);
    const inactiveTarget = seeded.profiles.find((p) => p.id === DEMO_USERS.tech2)!;
    inactiveTarget.active = false;
    storage.save(seeded);
    const repo = new LocalDemoRepository(storage, { now: () => FIXED_NOW });
    await expect(
      repo.createIncident(supervisor1, baseCreateInput({ ownerUserId: DEMO_USERS.tech2 })),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects a deleted/tombstoned internal owner', async () => {
    const storage = new MemoryStorage();
    const seeded = buildSeed(FIXED_NOW);
    const deletedTarget = seeded.profiles.find((p) => p.id === DEMO_USERS.tech2)!;
    deletedTarget.active = false;
    deletedTarget.deletedAt = FIXED_NOW.toISOString();
    storage.save(seeded);
    const repo = new LocalDemoRepository(storage, { now: () => FIXED_NOW });
    await expect(
      repo.createIncident(supervisor1, baseCreateInput({ ownerUserId: DEMO_USERS.tech2 })),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects an unknown owner id', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    await expect(
      repo.createIncident(supervisor1, baseCreateInput({ ownerUserId: 'not-a-real-profile-id' })),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

// Mirrors migration 0021's incident-opening completion: תקשוב למבצעים
// (reported_to_comms/reported_to_comms_recipient) and WISDOM
// (wisdom_reported/wisdom_incident_number). Every test here calls the
// repository directly, bypassing IncidentCreatePage entirely -- proving a
// direct repository/RPC caller cannot reach a state the real backend would
// reject, exactly like the ownership tests above.
describe('creation opening-time reporting: תקשוב למבצעים / WISDOM (mirrors migration 0021)', () => {
  it('both לא (the default): succeeds with no dependent value stored', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const incident = await repo.createIncident(supervisor1, baseCreateInput());
    expect(incident.reportedToComms).toBe(false);
    expect(incident.reportedToCommsRecipient).toBeNull();
    expect(incident.wisdomReported).toBe(false);
    expect(incident.wisdomIncidentNumber).toBeNull();
  });

  it('rejects תקשוב למבצעים כן without a למי דווח value, from a direct repository call', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    await expect(
      repo.createIncident(supervisor1, baseCreateInput({ reportedToComms: true, reportedToCommsRecipient: null })),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects תקשוב למבצעים כן with a whitespace-only למי דווח value', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    await expect(
      repo.createIncident(supervisor1, baseCreateInput({ reportedToComms: true, reportedToCommsRecipient: '   ' })),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('succeeds with תקשוב למבצעים כן and a trimmed recipient', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const incident = await repo.createIncident(
      supervisor1,
      baseCreateInput({ reportedToComms: true, reportedToCommsRecipient: '  תקשוב מוקד  ' }),
    );
    expect(incident.reportedToComms).toBe(true);
    expect(incident.reportedToCommsRecipient).toBe('תקשוב מוקד');
  });

  it('rejects WISDOM כן without an incident number, from a direct repository call', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    await expect(
      repo.createIncident(supervisor1, baseCreateInput({ wisdomReported: true, wisdomIncidentNumber: null })),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('succeeds with WISDOM כן and a trimmed incident number, kept as a plain string', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const incident = await repo.createIncident(
      supervisor1,
      baseCreateInput({ wisdomReported: true, wisdomIncidentNumber: '  WISDOM-2026-0099  ' }),
    );
    expect(incident.wisdomReported).toBe(true);
    expect(incident.wisdomIncidentNumber).toBe('WISDOM-2026-0099');
  });

  it('persisted values (both כן) survive a repository refetch, and the created event note carries both answers', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const created = await repo.createIncident(
      supervisor1,
      baseCreateInput({
        reportedToComms: true,
        reportedToCommsRecipient: 'תקשוב מוקד',
        wisdomReported: true,
        wisdomIncidentNumber: 'WISDOM-1',
      }),
    );

    // Simulate a page refresh: a fresh getIncident call, not the object
    // returned by createIncident itself.
    const refetched = await repo.getIncident(supervisor1, created.id);
    expect(refetched?.reportedToComms).toBe(true);
    expect(refetched?.reportedToCommsRecipient).toBe('תקשוב מוקד');
    expect(refetched?.wisdomReported).toBe(true);
    expect(refetched?.wisdomIncidentNumber).toBe('WISDOM-1');

    const events = await repo.getIncidentEvents(supervisor1, created.id);
    const createdEvent = events.find((e) => e.type === 'created');
    expect(createdEvent?.note).toContain('תקשוב למבצעים: כן (דווח ל: תקשוב מוקד)');
    expect(createdEvent?.note).toContain('WISDOM: כן (מספר תקלה: WISDOM-1)');
    // No separate event type was created for either answer.
    expect(events.some((e) => e.type.toString().includes('comms'))).toBe(false);
  });

  it('existing (pre-feature) incidents remain compatible: seeded incidents without these answers read as לא with no dependent value', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const inc1 = await repo.getIncident(supervisor1, 'inc-1');
    expect(inc1?.reportedToComms).toBe(false);
    expect(inc1?.reportedToCommsRecipient).toBeNull();
    expect(inc1?.wisdomReported).toBe(false);
    expect(inc1?.wisdomIncidentNumber).toBeNull();
  });

  it('does not regress incident numbering, ownership, or permissions when both answers are כן', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const before = await repo.createIncident(supervisor1, baseCreateInput());
    const after = await repo.createIncident(
      supervisor1,
      baseCreateInput({ reportedToComms: true, reportedToCommsRecipient: 'x', wisdomReported: true, wisdomIncidentNumber: 'y' }),
    );
    // Numbering still increments normally alongside the new fields.
    expect(after.number).not.toBe(before.number);
    expect(after.ownerUserId).toBe(DEMO_USERS.tech1);
    // Migration 0037: an active technician can now create an incident too,
    // regardless of these new fields being populated.
    const byTech = await repo.createIncident(
      tech1,
      baseCreateInput({ reportedToComms: true, reportedToCommsRecipient: 'x' }),
    );
    expect(byTech.createdBy).toBe(DEMO_USERS.tech1);
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
        eventTime: FIXED_NOW.toISOString(),
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
        eventTime: FIXED_NOW.toISOString(),
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
      eventTime: FIXED_NOW.toISOString(),
      rootCause: 'תקלת חומרה בכרטיס התקשורת',
      resolution: 'הוחלף הכרטיס ואומתה תקינות',
      readiness: 'full',
      followUpNotes: '',
      reportedToOps: 'yes',
      reportedToOpsRecipient: 'אחמ״ש מוקד מבצעים',
      note: '',
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
      eventTime: FIXED_NOW.toISOString(),
      rootCause: 'רכיב פגום',
      resolution: 'הותקן פתרון זמני',
      readiness: 'partial',
      followUpNotes: 'להתקין רכיב קבוע בהמשך',
      ownerUserId: DEMO_USERS.tech1,
      reportedToOps: 'no',
      note: '',
    });
    expect(closed.followUpRequired).toBe(true);
  });

  // Migration 0037 (mirrored here since the local repo enforces the same
  // capability matrix): an active technician may close ANY non-terminal
  // incident, regardless of current owner -- inc-2 is owned by tech2, not
  // tech1.
  it('allows a technician to close (full readiness) an incident owned by someone else', async () => {
    const incident = await repo.getIncident(tech1, 'inc-2');
    const closed = await repo.closeIncident(tech1, 'inc-2', {
      expectedVersion: incident!.version,
      eventTime: FIXED_NOW.toISOString(),
      rootCause: 'x',
      resolution: 'y',
      readiness: 'full',
      followUpNotes: '',
      reportedToOps: 'no',
      note: '',
    });
    expect(closed.status).toBe('closed');
    expect(closed.closedBy).toBe(DEMO_USERS.tech1);
  });

  it('allows a technician to close an incident owned by someone else with incomplete readiness', async () => {
    const incident = await repo.getIncident(tech1, 'inc-2');
    const closed = await repo.closeIncident(tech1, 'inc-2', {
      expectedVersion: incident!.version,
      eventTime: FIXED_NOW.toISOString(),
      rootCause: 'x',
      resolution: 'y',
      readiness: 'partial',
      followUpNotes: 'להשלים בהמשך',
      ownerUserId: DEMO_USERS.tech2,
      reportedToOps: 'no',
      note: '',
    });
    expect(closed.status).toBe('partial_readiness');
    expect(closed.followUpRequired).toBe(true);
  });

  it('rejects closing an already-closed incident', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-5'); // seeded closed
    await expect(
      repo.closeIncident(supervisor1, 'inc-5', {
        expectedVersion: incident!.version,
        eventTime: FIXED_NOW.toISOString(),
        rootCause: 'x',
        resolution: 'y',
        readiness: 'full',
        followUpNotes: '',
        reportedToOps: 'no',
        note: '',
      }),
    ).rejects.toThrow(AppError);
  });
});

// Retroactive closure time (PR D, migration 0033): close_incident gains a
// required, validated eventTime -- the actual moment the closure happened,
// distinct from server_time (when Nexus recorded it). Deliberately scoped:
// no reporting-field, export, readiness, or ownership behavior is touched
// by this feature.
describe('retroactive closure time (migration 0033)', () => {
  let repo: LocalDemoRepository;
  beforeEach(() => {
    repo = newRepo({ now: FIXED_NOW });
  });

  it('a backdated eventTime (within bounds) sets closedAt to that value, not "now"', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    const backdated = new Date(FIXED_NOW.getTime() - 2 * 60 * 60_000).toISOString(); // 2h before FIXED_NOW
    const closed = await repo.closeIncident(supervisor1, 'inc-2', {
      expectedVersion: incident!.version,
      eventTime: backdated,
      rootCause: 'תקלת חומרה',
      resolution: 'הוחלף רכיב',
      readiness: 'full',
      followUpNotes: '',
      reportedToOps: 'no',
    } as CloseIncidentInput);
    expect(closed.closedAt).toBe(backdated);
    expect(closed.closedAt).not.toBe(FIXED_NOW.toISOString());
  });

  it('the "closed" event carries the validated eventTime; createdAt (server-recorded time) stays the actual recording time, independently ~now', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    const backdated = new Date(FIXED_NOW.getTime() - 3 * 60 * 60_000).toISOString(); // 3h before FIXED_NOW
    await repo.closeIncident(supervisor1, 'inc-2', {
      expectedVersion: incident!.version,
      eventTime: backdated,
      rootCause: 'תקלת חומרה',
      resolution: 'הוחלף רכיב',
      readiness: 'full',
      followUpNotes: '',
      reportedToOps: 'no',
    } as CloseIncidentInput);
    const events = await repo.getIncidentEvents(supervisor1, 'inc-2');
    const closedEvent = events.find((e) => e.type === 'closed');
    expect(closedEvent).toBeDefined();
    expect(closedEvent!.eventTime).toBe(backdated);
    expect(closedEvent!.serverTime).toBe(FIXED_NOW.toISOString());
    expect(closedEvent!.eventTime).not.toBe(closedEvent!.serverTime);
  });

  it('exact discoveredAt boundary is accepted (inclusive lower bound)', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    const closed = await repo.closeIncident(supervisor1, 'inc-2', {
      expectedVersion: incident!.version,
      eventTime: incident!.discoveredAt,
      rootCause: 'תקלת חומרה',
      resolution: 'הוחלף רכיב',
      readiness: 'full',
      followUpNotes: '',
      reportedToOps: 'no',
    } as CloseIncidentInput);
    expect(closed.closedAt).toBe(incident!.discoveredAt);
  });

  it('exact now()+5min boundary is accepted (inclusive upper bound)', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    const boundary = new Date(FIXED_NOW.getTime() + 5 * 60_000).toISOString();
    const closed = await repo.closeIncident(supervisor1, 'inc-2', {
      expectedVersion: incident!.version,
      eventTime: boundary,
      rootCause: 'תקלת חומרה',
      resolution: 'הוחלף רכיב',
      readiness: 'full',
      followUpNotes: '',
      reportedToOps: 'no',
    } as CloseIncidentInput);
    expect(closed.closedAt).toBe(boundary);
  });

  it('rejects an eventTime before discoveredAt, leaving the incident, events, audits, and notifications byte-for-byte unchanged', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-2');
    const beforeEvents = await repo.getIncidentEvents(supervisor1, 'inc-2');
    const beforeAudits = await repo.listAuditLogs(admin, {});
    const beforeNotifications = await repo.listNotifications(supervisor1);
    const tooEarly = new Date(new Date(before!.discoveredAt).getTime() - 60_000).toISOString();

    await expect(
      repo.closeIncident(supervisor1, 'inc-2', {
        expectedVersion: before!.version,
        eventTime: tooEarly,
        rootCause: 'תקלת חומרה',
        resolution: 'הוחלף רכיב',
        readiness: 'full',
        followUpNotes: '',
        reportedToOps: 'no',
      } as CloseIncidentInput),
    ).rejects.toThrow(AppError);

    const after = await repo.getIncident(supervisor1, 'inc-2');
    const afterEvents = await repo.getIncidentEvents(supervisor1, 'inc-2');
    const afterAudits = await repo.listAuditLogs(admin, {});
    const afterNotifications = await repo.listNotifications(supervisor1);
    expect(after).toEqual(before);
    expect(afterEvents).toEqual(beforeEvents);
    expect(afterAudits).toEqual(beforeAudits);
    expect(afterNotifications).toEqual(beforeNotifications);
  });

  it('rejects a malformed, unparseable eventTime ("not-a-date"), leaving state unchanged', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-2');
    const beforeEvents = await repo.getIncidentEvents(supervisor1, 'inc-2');
    const beforeAudits = await repo.listAuditLogs(admin, {});
    const beforeNotifications = await repo.listNotifications(supervisor1);

    await expect(
      repo.closeIncident(supervisor1, 'inc-2', {
        expectedVersion: before!.version,
        eventTime: 'not-a-date',
        rootCause: 'תקלת חומרה',
        resolution: 'הוחלף רכיב',
        readiness: 'full',
        followUpNotes: '',
        reportedToOps: 'no',
      } as CloseIncidentInput),
    ).rejects.toThrow(AppError);

    const after = await repo.getIncident(supervisor1, 'inc-2');
    const afterEvents = await repo.getIncidentEvents(supervisor1, 'inc-2');
    const afterAudits = await repo.listAuditLogs(admin, {});
    const afterNotifications = await repo.listNotifications(supervisor1);
    expect(after).toEqual(before);
    expect(afterEvents).toEqual(beforeEvents);
    expect(afterAudits).toEqual(beforeAudits);
    expect(afterNotifications).toEqual(beforeNotifications);
  });

  it('rejects an eventTime beyond now()+5 minutes, leaving state unchanged', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-2');
    const beforeEvents = await repo.getIncidentEvents(supervisor1, 'inc-2');
    const tooLate = new Date(FIXED_NOW.getTime() + 6 * 60_000).toISOString();

    await expect(
      repo.closeIncident(supervisor1, 'inc-2', {
        expectedVersion: before!.version,
        eventTime: tooLate,
        rootCause: 'תקלת חומרה',
        resolution: 'הוחלף רכיב',
        readiness: 'full',
        followUpNotes: '',
        reportedToOps: 'no',
      } as CloseIncidentInput),
    ).rejects.toThrow(AppError);

    const after = await repo.getIncident(supervisor1, 'inc-2');
    const afterEvents = await repo.getIncidentEvents(supervisor1, 'inc-2');
    expect(after).toEqual(before);
    expect(afterEvents).toEqual(beforeEvents);
  });

  it('applies the validated eventTime identically in the partial-readiness branch, without setting closedAt (readiness behavior preserved)', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    const backdated = new Date(FIXED_NOW.getTime() - 60 * 60_000).toISOString();
    const partial = await repo.closeIncident(supervisor1, 'inc-2', {
      expectedVersion: incident!.version,
      eventTime: backdated,
      rootCause: 'תקלת חומרה',
      resolution: 'הוחלף רכיב זמני',
      readiness: 'partial',
      followUpNotes: 'להזמין רכיב קבוע',
      ownerUserId: DEMO_USERS.tech2,
      reportedToOps: 'no',
    } as CloseIncidentInput);
    expect(partial.status).toBe('partial_readiness');
    expect(partial.closedAt).toBeNull();

    const events = await repo.getIncidentEvents(supervisor1, 'inc-2');
    const statusChangeEvent = events.find((e) => e.type === 'status_change' && e.newValue === 'partial_readiness');
    expect(statusChangeEvent).toBeDefined();
    expect(statusChangeEvent!.eventTime).toBe(backdated);
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
      eventTime: FIXED_NOW.toISOString(),
      rootCause: 'תקלת חומרה',
      resolution: 'הוחלף רכיב זמני',
      readiness: 'partial',
      followUpNotes: 'להזמין רכיב קבוע',
      ownerUserId: DEMO_USERS.tech2,
      reportedToOps: 'no',
      note: '',
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
      eventTime: FIXED_NOW.toISOString(),
      rootCause: 'תקלת חומרה חמורה',
      resolution: 'טופל חלקית',
      readiness: 'none',
      followUpNotes: 'להמשיך טיפול',
      ownerUserId: DEMO_USERS.tech1,
      reportedToOps: 'no',
      note: '',
    });
    expect(result.status).toBe('partial_readiness');
    expect(result.closedAt).toBeNull();
  });

  it('requires a responsible owner when readiness is not full', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    await expect(
      repo.closeIncident(supervisor1, 'inc-2', {
        expectedVersion: incident!.version,
        eventTime: FIXED_NOW.toISOString(),
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
      eventTime: FIXED_NOW.toISOString(),
      rootCause: 'תקלת חומרה',
      resolution: 'תוקנה במלואה',
      readiness: 'full',
      followUpNotes: '',
      reportedToOps: 'no',
      note: '',
    });
    expect(result.status).toBe('closed');
    expect(result.closedAt).not.toBeNull();
    expect(result.followUpRequired).toBe(false);
  });

  it('allows closing again for real once a partial-readiness incident reaches full readiness', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    const partial = await repo.closeIncident(supervisor1, 'inc-2', {
      expectedVersion: incident!.version,
      eventTime: FIXED_NOW.toISOString(),
      rootCause: 'תקלת חומרה',
      resolution: 'הוחלף רכיב זמני',
      readiness: 'partial',
      followUpNotes: 'להזמין רכיב קבוע',
      ownerUserId: DEMO_USERS.tech2,
      reportedToOps: 'no',
      note: '',
    });
    expect(partial.status).toBe('partial_readiness');

    const closed = await repo.closeIncident(supervisor1, 'inc-2', {
      expectedVersion: partial.version,
      eventTime: FIXED_NOW.toISOString(),
      rootCause: 'תקלת חומרה',
      resolution: 'הותקן רכיב קבוע ואומתה תקינות מלאה',
      readiness: 'full',
      followUpNotes: '',
      reportedToOps: 'no',
      note: '',
    });
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
  });
});

// Update-specific reporting (migration 0031): three fresh per-update
// questions (updateReportedToOps/updateReportedToComms/updateWisdomReported),
// deliberately distinct from and never mutating the incident's own
// opening-time reportedToOps/reportedToOpsRecipient facts. Replaces the old
// "reporting recipient" coverage, which asserted the now-removed behavior of
// update_incident overwriting incidents.reportedToOps/.reportedToOpsRecipient
// and emitting a reported_to_ops_change event on every full update.
describe('update-specific reporting (migration 0031)', () => {
  let repo: LocalDemoRepository;
  beforeEach(() => {
    repo = newRepo({ now: FIXED_NOW });
  });

  function baseUpdateInput(
    incident: { status: string; severity: string; ownerUserId: string | null; version: number },
    overrides: Record<string, unknown> = {},
  ) {
    return {
      expectedVersion: incident.version,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'עדכון',
      findings: '',
      nextSteps: '',
      status: incident.status,
      severity: incident.severity,
      currentStatusText: 'המצב הנוכחי לצורך בדיקה',
      changeReason: '',
      ownerUserId: incident.ownerUserId,
      updateReportedToOps: 'not_required',
      updateReportedToOpsRecipient: null,
      updateReportedToComms: 'no',
      updateReportedToCommsRecipient: null,
      updateWisdomReported: 'no',
      ...overrides,
    } as Parameters<LocalDemoRepository['updateIncident']>[2];
  }

  it('rejects an unanswered updateReportedToOps/updateReportedToComms/updateWisdomReported question', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    await expect(
      repo.updateIncident(supervisor1, 'inc-2', baseUpdateInput(incident!, { updateReportedToOps: '' })),
    ).rejects.toThrow(AppError);
    await expect(
      repo.updateIncident(supervisor1, 'inc-2', baseUpdateInput(incident!, { updateReportedToComms: '' })),
    ).rejects.toThrow(AppError);
    await expect(
      repo.updateIncident(supervisor1, 'inc-2', baseUpdateInput(incident!, { updateWisdomReported: '' })),
    ).rejects.toThrow(AppError);
  });

  it('requires a recipient only when updateReportedToOps is "yes", and preserves the yes/no/not_required answer set', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    await expect(
      repo.updateIncident(
        supervisor1,
        'inc-2',
        baseUpdateInput(incident!, { updateReportedToOps: 'yes', updateReportedToOpsRecipient: '' }),
      ),
    ).rejects.toThrow(AppError);

    const withRecipient = await repo.updateIncident(
      supervisor1,
      'inc-2',
      baseUpdateInput(incident!, { updateReportedToOps: 'yes', updateReportedToOpsRecipient: 'אחמ״ש מוקד מבצעים' }),
    );
    const updates = await repo.getIncidentUpdates(supervisor1, 'inc-2');
    const latest = updates[updates.length - 1];
    expect(latest.updateReportedToOps).toBe('yes');
    expect(latest.updateReportedToOpsRecipient).toBe('אחמ״ש מוקד מבצעים');

    // Not required, and left null, when the answer is "not_required".
    await repo.updateIncident(
      supervisor1,
      'inc-2',
      baseUpdateInput({ ...incident!, version: withRecipient.version }, { updateReportedToOps: 'not_required' }),
    );
    const updates2 = await repo.getIncidentUpdates(supervisor1, 'inc-2');
    const latest2 = updates2[updates2.length - 1];
    expect(latest2.updateReportedToOps).toBe('not_required');
    expect(latest2.updateReportedToOpsRecipient).toBeNull();
  });

  it('requires a recipient only when updateReportedToComms is "yes"', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    await expect(
      repo.updateIncident(
        supervisor1,
        'inc-2',
        baseUpdateInput(incident!, { updateReportedToComms: 'yes', updateReportedToCommsRecipient: '' }),
      ),
    ).rejects.toThrow(AppError);

    await repo.updateIncident(
      supervisor1,
      'inc-2',
      baseUpdateInput(incident!, { updateReportedToComms: 'yes', updateReportedToCommsRecipient: 'תקשוב מוקד מבצעים' }),
    );
    const updates = await repo.getIncidentUpdates(supervisor1, 'inc-2');
    const latest = updates[updates.length - 1];
    expect(latest.updateReportedToComms).toBe(true);
    expect(latest.updateReportedToCommsRecipient).toBe('תקשוב מוקד מבצעים');
  });

  it('persists all three update-specific reporting answers on the update row, and leaves the incident-level opening facts untouched', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    const before = {
      reportedToOps: incident!.reportedToOps,
      reportedToOpsRecipient: incident!.reportedToOpsRecipient,
    };
    await repo.updateIncident(
      supervisor1,
      'inc-2',
      baseUpdateInput(incident!, {
        updateReportedToOps: 'yes',
        updateReportedToOpsRecipient: 'יוסי מהמוקד',
        updateReportedToComms: 'yes',
        updateReportedToCommsRecipient: 'דנה מהתקשוב',
        updateWisdomReported: 'yes',
      }),
    );
    const updates = await repo.getIncidentUpdates(supervisor1, 'inc-2');
    const latest = updates[updates.length - 1];
    expect(latest.updateReportedToOps).toBe('yes');
    expect(latest.updateReportedToOpsRecipient).toBe('יוסי מהמוקד');
    expect(latest.updateReportedToComms).toBe(true);
    expect(latest.updateReportedToCommsRecipient).toBe('דנה מהתקשוב');
    expect(latest.updateWisdomReported).toBe(true);

    const after = await repo.getIncident(supervisor1, 'inc-2');
    expect(after!.reportedToOps).toBe(before.reportedToOps);
    expect(after!.reportedToOpsRecipient).toBe(before.reportedToOpsRecipient);
  });

  it('no longer emits a reported_to_ops_change event from a full update', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    await repo.updateIncident(
      supervisor1,
      'inc-2',
      baseUpdateInput(incident!, { updateReportedToOps: 'yes', updateReportedToOpsRecipient: 'יוסי מהמוקד' }),
    );
    const events = await repo.getIncidentEvents(supervisor1, 'inc-2');
    expect(events.some((e) => e.type === 'reported_to_ops_change')).toBe(false);
  });

  it('tolerates a legacy reportedToOps/reportedToOpsRecipient payload key without treating it as update-specific reporting or touching the incident-level fields', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    const before = {
      reportedToOps: incident!.reportedToOps,
      reportedToOpsRecipient: incident!.reportedToOpsRecipient,
    };
    const legacyPayload = {
      ...baseUpdateInput(incident!),
      reportedToOps: 'yes',
      reportedToOpsRecipient: 'ערך מלקוח ישן',
    } as Parameters<LocalDemoRepository['updateIncident']>[2];
    await repo.updateIncident(supervisor1, 'inc-2', legacyPayload);

    const after = await repo.getIncident(supervisor1, 'inc-2');
    expect(after!.reportedToOps).toBe(before.reportedToOps);
    expect(after!.reportedToOpsRecipient).toBe(before.reportedToOpsRecipient);

    const updates = await repo.getIncidentUpdates(supervisor1, 'inc-2');
    const latest = updates[updates.length - 1];
    // The legacy key must not be misread as an answer to the new question.
    expect(latest.updateReportedToOps).toBe('not_required');
  });
});

// Additive external handling party (migration 0032 / PR C): preserve-on-
// omit (key absent from the parsed input), update-on-supply, clear-on-
// explicit-null across every lifecycle writer; the legacy owner_external_name
// column survives byte-identical once a legacy external-only incident (inc-3
// open, inc-9 closed) gains a mandatory internal owner; a legacy
// ownerExternalName payload key is tolerated but never persisted.
describe('external handling party (migration 0032)', () => {
  let repo: LocalDemoRepository;
  beforeEach(() => {
    repo = newRepo({ now: FIXED_NOW });
  });

  it('create_incident: persists the full external-handler trio alongside the mandatory internal owner', async () => {
    const incident = await repo.createIncident(
      supervisor1,
      baseCreateInput({
        externalHandlerName: 'ארגון שותף',
        externalHandlerContactPerson: 'דנה',
        externalHandlerContactDetails: '03-1234567',
      } as CreateIncidentInput),
    );
    expect(incident.externalHandlerName).toBe('ארגון שותף');
    expect(incident.externalHandlerContactPerson).toBe('דנה');
    expect(incident.externalHandlerContactDetails).toBe('03-1234567');
  });

  it('update_incident: omitting the external-handler keys preserves the incident\'s existing values', async () => {
    const incident = await repo.updateIncident(supervisor1, 'inc-4', {
      expectedVersion: (await repo.getIncident(supervisor1, 'inc-4'))!.version,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'עדכון',
      findings: '',
      nextSteps: '',
      currentStatusText: 'בדיקה',
      status: 'monitoring',
      severity: 'low',
      changeReason: '',
      ownerUserId: DEMO_USERS.supervisor1,
      updateReportedToOps: 'not_required',
      updateReportedToComms: 'no',
      updateWisdomReported: 'no',
    } as Parameters<LocalDemoRepository['updateIncident']>[2]);
    // inc-4 was seeded with no external handler at all -- omitting the keys
    // must leave it at null, not clear-by-omission.
    expect(incident.externalHandlerName).toBeNull();
    expect(incident.externalHandlerContactPerson).toBeNull();
    expect(incident.externalHandlerContactDetails).toBeNull();
  });

  it('update_incident: supplying the trio sets it, and a later explicit-null call clears it', async () => {
    const incident1 = await repo.getIncident(supervisor1, 'inc-1');
    const set = await repo.updateIncident(supervisor1, 'inc-1', {
      expectedVersion: incident1!.version,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'עדכון',
      findings: '',
      nextSteps: '',
      currentStatusText: 'בדיקה',
      status: incident1!.status,
      severity: incident1!.severity,
      changeReason: '',
      ownerUserId: incident1!.ownerUserId,
      externalHandlerName: 'ארגון חדש',
      externalHandlerContactPerson: 'משה',
      updateReportedToOps: 'not_required',
      updateReportedToComms: 'no',
      updateWisdomReported: 'no',
    } as Parameters<LocalDemoRepository['updateIncident']>[2]);
    expect(set.externalHandlerName).toBe('ארגון חדש');
    expect(set.externalHandlerContactPerson).toBe('משה');

    const cleared = await repo.updateIncident(supervisor1, 'inc-1', {
      expectedVersion: set.version,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'עדכון נוסף',
      findings: '',
      nextSteps: '',
      currentStatusText: 'בדיקה',
      status: set.status,
      severity: set.severity,
      changeReason: '',
      ownerUserId: set.ownerUserId,
      externalHandlerName: null,
      externalHandlerContactPerson: null,
      updateReportedToOps: 'not_required',
      updateReportedToComms: 'no',
      updateWisdomReported: 'no',
    } as Parameters<LocalDemoRepository['updateIncident']>[2]);
    expect(cleared.externalHandlerName).toBeNull();
    expect(cleared.externalHandlerContactPerson).toBeNull();
  });

  it('update_incident: a contact-only change (name unchanged) still emits a field=external_handler event with distinct old/new snapshots', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-1');
    await repo.updateIncident(supervisor1, 'inc-1', {
      expectedVersion: before!.version,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'עדכון',
      findings: '',
      nextSteps: '',
      currentStatusText: 'בדיקה',
      status: before!.status,
      severity: before!.severity,
      changeReason: '',
      ownerUserId: before!.ownerUserId,
      externalHandlerName: 'ארגון קבוע',
      externalHandlerContactPerson: 'איש קשר א',
      updateReportedToOps: 'not_required',
      updateReportedToComms: 'no',
      updateWisdomReported: 'no',
    } as Parameters<LocalDemoRepository['updateIncident']>[2]);
    const afterFirst = await repo.getIncident(supervisor1, 'inc-1');
    await repo.updateIncident(supervisor1, 'inc-1', {
      expectedVersion: afterFirst!.version,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'עדכון שני',
      findings: '',
      nextSteps: '',
      currentStatusText: 'בדיקה',
      status: afterFirst!.status,
      severity: afterFirst!.severity,
      changeReason: '',
      ownerUserId: afterFirst!.ownerUserId,
      externalHandlerContactPerson: 'איש קשר ב', // name key omitted -> preserved
      updateReportedToOps: 'not_required',
      updateReportedToComms: 'no',
      updateWisdomReported: 'no',
    } as Parameters<LocalDemoRepository['updateIncident']>[2]);

    const events = await repo.getIncidentEvents(supervisor1, 'inc-1');
    const extEvents = events.filter((e) => e.field === 'external_handler');
    expect(extEvents.length).toBe(2);
    const latest = extEvents[extEvents.length - 1];
    expect(latest.oldValue).not.toBe(latest.newValue);
    expect(latest.oldValue).toMatch(/ארגון קבוע/);
    expect(latest.oldValue).toMatch(/איש קשר א/);
    expect(latest.newValue).toMatch(/ארגון קבוע/);
    expect(latest.newValue).toMatch(/איש קשר ב/);
  });

  it('update_incident on a legacy external-only incident (inc-3): a valid internal owner is now required, and owner_external_name survives byte-identical', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-3');
    expect(before!.ownerUserId).toBeNull();
    const legacyExternalName = before!.ownerExternalName;
    expect(legacyExternalName).not.toBeNull();

    const updated = await repo.updateIncident(supervisor1, 'inc-3', {
      expectedVersion: before!.version,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'עדכון',
      findings: '',
      nextSteps: '',
      currentStatusText: 'בדיקה',
      status: before!.status,
      severity: before!.severity,
      changeReason: '',
      ownerUserId: DEMO_USERS.tech1,
      updateReportedToOps: 'not_required',
      updateReportedToComms: 'no',
      updateWisdomReported: 'no',
    } as Parameters<LocalDemoRepository['updateIncident']>[2]);
    expect(updated.ownerUserId).toBe(DEMO_USERS.tech1);
    // Frozen historical column -- untouched by this write, even though an
    // internal owner has now been assigned.
    expect(updated.ownerExternalName).toBe(legacyExternalName);
  });

  it('update_incident rejects a missing internal owner even on a legacy external-only incident', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-3');
    await expect(
      repo.updateIncident(supervisor1, 'inc-3', {
        expectedVersion: before!.version,
        eventTime: FIXED_NOW.toISOString(),
        actionsTaken: 'עדכון',
        findings: '',
        nextSteps: '',
        currentStatusText: 'בדיקה',
        status: before!.status,
        severity: before!.severity,
        changeReason: '',
        ownerUserId: null,
        updateReportedToOps: 'not_required',
        updateReportedToComms: 'no',
        updateWisdomReported: 'no',
      } as Parameters<LocalDemoRepository['updateIncident']>[2]),
    ).rejects.toThrow(AppError);
  });

  it('update_incident: a rejected external-handler payload leaves the incident, its updates, events, audits, and notifications byte-for-byte unchanged, even when the same call also proposes a genuine status/severity/owner change', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-1'); // seeded with no external handler
    expect(before!.externalHandlerName).toBeNull();
    const updatesBefore = await repo.getIncidentUpdates(supervisor1, 'inc-1');
    const eventsBefore = await repo.getIncidentEvents(supervisor1, 'inc-1');
    const auditBefore = await repo.listAuditLogs(admin, { incidentNumber: before!.number });
    const notificationsBefore = await repo.listNotifications(tech2);

    await expect(
      repo.updateIncident(supervisor1, 'inc-1', {
        expectedVersion: before!.version,
        eventTime: FIXED_NOW.toISOString(),
        actionsTaken: 'ניסיון עדכון עם מטען לא תקין',
        findings: '',
        nextSteps: '',
        currentStatusText: 'בדיקה',
        status: 'monitoring', // genuine status change, proposed alongside the invalid payload
        severity: 'high', // genuine severity change
        changeReason: '',
        ownerUserId: DEMO_USERS.tech2, // genuine owner change
        externalHandlerContactPerson: 'דנה', // name omitted -> preserved as null -> invalid
        updateReportedToOps: 'not_required',
        updateReportedToComms: 'no',
        updateWisdomReported: 'no',
      } as Parameters<LocalDemoRepository['updateIncident']>[2]),
    ).rejects.toThrow(AppError);

    const after = await repo.getIncident(supervisor1, 'inc-1');
    expect(after).toEqual(before);
    expect(await repo.getIncidentUpdates(supervisor1, 'inc-1')).toEqual(updatesBefore);
    expect(await repo.getIncidentEvents(supervisor1, 'inc-1')).toEqual(eventsBefore);
    expect(await repo.listAuditLogs(admin, { incidentNumber: before!.number })).toEqual(auditBefore);
    expect(await repo.listNotifications(tech2)).toEqual(notificationsBefore);
  });

  it('assign_incident: repository-level guard rejects a contact-only merged result (name omitted, incident had none) -- the schema alone cannot catch this since it has no visibility into the existing incident', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-4'); // seeded with no external handler
    expect(before!.externalHandlerName).toBeNull();
    await expect(
      repo.assignIncident(supervisor1, 'inc-4', {
        expectedVersion: before!.version,
        note: '',
        ownerUserId: DEMO_USERS.tech2,
        externalHandlerContactPerson: 'דנה', // name key omitted -> preserved as null
      } as Parameters<LocalDemoRepository['assignIncident']>[2]),
    ).rejects.toThrow(AppError);
  });

  it('assign_incident: a rejected external-handler payload leaves the incident, events, audits, and notifications byte-for-byte unchanged, even when the same call also proposes a genuine owner change', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-4'); // seeded with no external handler
    expect(before!.externalHandlerName).toBeNull();
    const eventsBefore = await repo.getIncidentEvents(supervisor1, 'inc-4');
    const auditBefore = await repo.listAuditLogs(admin, { incidentNumber: before!.number });
    const notificationsBefore = await repo.listNotifications(tech2);

    await expect(
      repo.assignIncident(supervisor1, 'inc-4', {
        expectedVersion: before!.version,
        note: '',
        ownerUserId: DEMO_USERS.tech2, // genuine owner change, proposed alongside the invalid payload
        externalHandlerContactPerson: 'דנה', // name omitted -> preserved as null -> invalid
      } as Parameters<LocalDemoRepository['assignIncident']>[2]),
    ).rejects.toThrow(AppError);

    const after = await repo.getIncident(supervisor1, 'inc-4');
    expect(after).toEqual(before);
    expect(await repo.getIncidentEvents(supervisor1, 'inc-4')).toEqual(eventsBefore);
    expect(await repo.listAuditLogs(admin, { incidentNumber: before!.number })).toEqual(auditBefore);
    expect(await repo.listNotifications(tech2)).toEqual(notificationsBefore);
  });

  it('assign_incident: preserve/update/clear semantics and a separate field=external_handler event', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-4');
    const assigned = await repo.assignIncident(supervisor1, 'inc-4', {
      expectedVersion: before!.version,
      note: '',
      ownerUserId: DEMO_USERS.tech2,
      externalHandlerName: 'ארגון הקצאה',
    } as Parameters<LocalDemoRepository['assignIncident']>[2]);
    expect(assigned.externalHandlerName).toBe('ארגון הקצאה');

    const events = await repo.getIncidentEvents(supervisor1, 'inc-4');
    expect(events.filter((e) => e.field === 'owner').length).toBe(1);
    expect(events.filter((e) => e.field === 'external_handler').length).toBe(1);

    const preserved = await repo.assignIncident(supervisor1, 'inc-4', {
      expectedVersion: assigned.version,
      note: '',
      ownerUserId: DEMO_USERS.tech1,
    } as Parameters<LocalDemoRepository['assignIncident']>[2]);
    expect(preserved.externalHandlerName).toBe('ארגון הקצאה');
  });

  it('assign_incident: same owner + changed external handler emits ONLY the external_handler event -- no fake owner event, no reassignment audit, no reassignment notification', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-4');
    const sameOwner = before!.ownerUserId!; // DEMO_USERS.supervisor1 (seed.ts)
    // Actor is deliberately NOT the owner, so a genuine reassignment here
    // would have sent supervisor1 a notification -- proving the assertion
    // below tests the owner-unchanged gate, not the pre-existing
    // self-assignment-never-notifies rule.
    const assigned = await repo.assignIncident(manager, 'inc-4', {
      expectedVersion: before!.version,
      note: '',
      ownerUserId: sameOwner,
      externalHandlerName: 'ארגון ללא שינוי בעלים',
    } as Parameters<LocalDemoRepository['assignIncident']>[2]);
    expect(assigned.ownerUserId).toBe(sameOwner);
    expect(assigned.externalHandlerName).toBe('ארגון ללא שינוי בעלים');

    const events = await repo.getIncidentEvents(supervisor1, 'inc-4');
    expect(events.filter((e) => e.field === 'owner').length).toBe(0);
    expect(events.filter((e) => e.field === 'external_handler').length).toBe(1);

    const auditLog = await repo.listAuditLogs(admin, { incidentNumber: before!.number });
    expect(auditLog.filter((a) => a.action === 'incident_assigned').length).toBe(0);

    const notifications = await repo.listNotifications(supervisor1);
    expect(notifications.filter((n) => n.type === 'incident_assigned' && n.incidentId === 'inc-4').length).toBe(0);
  });

  // Migration 0037: an active technician may reassign/change the handling
  // party on ANY non-terminal incident, regardless of current owner --
  // inc-4 is owned by supervisor1, not tech1.
  it('allows a technician to reassign an incident owned by someone else', async () => {
    const before = await repo.getIncident(tech1, 'inc-4');
    const assigned = await repo.assignIncident(tech1, 'inc-4', {
      expectedVersion: before!.version,
      note: '',
      ownerUserId: DEMO_USERS.tech2,
    } as Parameters<LocalDemoRepository['assignIncident']>[2]);
    expect(assigned.ownerUserId).toBe(DEMO_USERS.tech2);
  });

  it('close_incident (full readiness): accepts the external-handler trio without touching owner columns', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-2');
    const closed = await repo.closeIncident(supervisor1, 'inc-2', {
      expectedVersion: before!.version,
      eventTime: FIXED_NOW.toISOString(),
      rootCause: 'סיבה',
      resolution: 'פתרון',
      readiness: 'full',
      followUpNotes: '',
      externalHandlerName: 'ארגון סגירה',
      reportedToOps: 'no',
    } as CloseIncidentInput);
    expect(closed.status).toBe('closed');
    expect(closed.externalHandlerName).toBe('ארגון סגירה');
  });

  it('close_incident (partial readiness): applies preserve/update/clear semantics alongside the (still-mandatory) internal owner', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-3');
    const partial = await repo.closeIncident(supervisor1, 'inc-3', {
      expectedVersion: before!.version,
      eventTime: FIXED_NOW.toISOString(),
      rootCause: 'סיבה',
      resolution: 'פתרון חלקי',
      readiness: 'partial',
      followUpNotes: 'להשלים טיפול',
      ownerUserId: DEMO_USERS.tech1,
      externalHandlerName: 'ארגון בסגירה חלקית',
      reportedToOps: 'no',
    } as CloseIncidentInput);
    expect(partial.status).toBe('partial_readiness');
    expect(partial.ownerUserId).toBe(DEMO_USERS.tech1);
    expect(partial.externalHandlerName).toBe('ארגון בסגירה חלקית');
    // Frozen historical column -- untouched even though an internal owner
    // was just assigned.
    expect(partial.ownerExternalName).toBe(before!.ownerExternalName);
  });

  it('reopen_incident on a legacy CLOSED external-only incident (inc-9): requires an internal owner, owner_external_name survives byte-identical', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-9');
    expect(before!.status).toBe('closed');
    expect(before!.ownerUserId).toBeNull();
    const legacyExternalName = before!.ownerExternalName;
    expect(legacyExternalName).not.toBeNull();
    // inc-9 was already backfilled (mirroring migration 0032's backfill) --
    // externalHandlerName equals the legacy owner_external_name.
    expect(before!.externalHandlerName).toBe(legacyExternalName);

    const reopened = await repo.reopenIncident(manager, 'inc-9', {
      expectedVersion: before!.version,
      reason: 'התברר שהתקלה חוזרת',
      ownerUserId: DEMO_USERS.tech2,
    } as ReopenIncidentInput);
    expect(reopened.status).toBe('reopened');
    expect(reopened.ownerUserId).toBe(DEMO_USERS.tech2);
    expect(reopened.ownerExternalName).toBe(legacyExternalName);
    // Omitting the external-handler keys preserved the already-backfilled value.
    expect(reopened.externalHandlerName).toBe(legacyExternalName);
  });

  it('reopen_incident rejects a missing internal owner', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-9');
    await expect(
      repo.reopenIncident(manager, 'inc-9', {
        expectedVersion: before!.version,
        reason: 'סיבה',
        ownerUserId: null,
      } as ReopenIncidentInput),
    ).rejects.toThrow(AppError);
  });

  it('reopen_incident: a rejected external-handler payload leaves the (still-closed) incident, events, audits, and notifications byte-for-byte unchanged, even when the same call also proposes a genuine owner change', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-5'); // seeded closed, no external handler
    expect(before!.status).toBe('closed');
    expect(before!.externalHandlerName).toBeNull();
    const eventsBefore = await repo.getIncidentEvents(supervisor1, 'inc-5');
    const auditBefore = await repo.listAuditLogs(admin, { incidentNumber: before!.number });
    const notificationsBefore = await repo.listNotifications(tech2);

    await expect(
      repo.reopenIncident(manager, 'inc-5', {
        expectedVersion: before!.version,
        reason: 'התברר שהתקלה חוזרת',
        ownerUserId: DEMO_USERS.tech2, // genuine owner change, proposed alongside the invalid payload
        externalHandlerContactPerson: 'דנה', // name omitted -> preserved as null -> invalid
      } as Parameters<LocalDemoRepository['reopenIncident']>[2]),
    ).rejects.toThrow(AppError);

    const after = await repo.getIncident(supervisor1, 'inc-5');
    expect(after).toEqual(before);
    expect(await repo.getIncidentEvents(supervisor1, 'inc-5')).toEqual(eventsBefore);
    expect(await repo.listAuditLogs(admin, { incidentNumber: before!.number })).toEqual(auditBefore);
    expect(await repo.listNotifications(tech2)).toEqual(notificationsBefore);
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
        ownerUserId: DEMO_USERS.tech1,
      }),
    ).rejects.toThrow(AppError);
  });

  it('denies shift_supervisor reopen by default policy', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-5');
    await expect(
      repo.reopenIncident(supervisor1, 'inc-5', {
        expectedVersion: incident!.version,
        reason: 'התופעה חזרה',
        ownerUserId: DEMO_USERS.tech1,
      }),
    ).rejects.toThrow(AppError);
  });

  it('allows shift_supervisor reopen once policy explicitly grants it', async () => {
    repo.setPolicy({ allowSupervisorReopen: true });
    const incident = await repo.getIncident(supervisor1, 'inc-5');
    const reopened = await repo.reopenIncident(supervisor1, 'inc-5', {
      expectedVersion: incident!.version,
      reason: 'התופעה חזרה',
      ownerUserId: DEMO_USERS.tech1,
    });
    expect(reopened.status).toBe('reopened');
  });

  it('allows professional_manager to reopen and requires reason + owner (no next-update deadline -- that concept was removed)', async () => {
    const before = await repo.getIncident(manager, 'inc-5');
    const reopened = await repo.reopenIncident(manager, 'inc-5', {
      expectedVersion: before!.version,
      reason: 'התגלה שהתקלה לא נפתרה במלואה',
      ownerUserId: DEMO_USERS.tech2,
    } satisfies ReopenIncidentInput);
    expect(reopened.status).toBe('reopened');
    expect(reopened.ownerUserId).toBe(DEMO_USERS.tech2);
    expect(reopened.reopenCount).toBe(1);
    expect(reopened.closedAt).toBeNull();
    // next_update_due/no_deadline_reason are no longer asked for on reopen --
    // whatever the incident had before (here, closed's own values) carries
    // forward untouched.
    expect(reopened.nextUpdateDue).toBe(before!.nextUpdateDue);
    expect(reopened.noDeadlineReason).toBe(before!.noDeadlineReason);

    const events = await repo.getIncidentEvents(manager, 'inc-5');
    expect(events.some((e) => e.type === 'reopened')).toBe(true);
  });

  it('rejects reopening without a reason', async () => {
    const incident = await repo.getIncident(manager, 'inc-6');
    await expect(
      repo.reopenIncident(manager, 'inc-6', {
        expectedVersion: incident!.version,
        reason: '',
        ownerUserId: DEMO_USERS.tech1,
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
      currentStatusText: 'המצב הנוכחי לצורך בדיקה',
      note: '',
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
        currentStatusText: 'המצב הנוכחי לצורך בדיקה',
        note: '',
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
        currentStatusText: 'שינוי לא מורשה',
        changeReason: '',
        note: '',
        ownerUserId: DEMO_USERS.tech1,
        updateReportedToOps: 'not_required',
        updateReportedToOpsRecipient: null,
        updateReportedToComms: 'no',
        updateReportedToCommsRecipient: null,
        updateWisdomReported: 'no',
      }),
    ).rejects.toThrow(AppError);
  });

  // acknowledge_incident is unaffected by migration 0037 -- still gated by
  // is_operational_role() alone.
  it('denies a technician from acknowledging an incident', async () => {
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
      currentStatusText: 'המצב הנוכחי לצורך בדיקה',
      changeReason: '',
      note: '',
      ownerUserId: incident!.ownerUserId,
      updateReportedToOps: 'not_required',
      updateReportedToOpsRecipient: null,
      updateReportedToComms: 'no',
      updateReportedToCommsRecipient: null,
      updateWisdomReported: 'no',
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
        currentStatusText: 'המצב הנוכחי לצורך בדיקה',
        changeReason: '',
        note: '',
        ownerUserId: incident!.ownerUserId,
        updateReportedToOps: 'not_required',
        updateReportedToOpsRecipient: null,
        updateReportedToComms: 'no',
        updateReportedToCommsRecipient: null,
        updateWisdomReported: 'no',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

// Mirrors migration 0020's event-time integrity rules for update_incident/
// technician_update_incident: eventTime must parse, and must fall within
// [incident.discoveredAt, now + 5 minutes] -- the same bounds
// cancelIncident already enforced. A direct repository caller -- bypassing
// UpdateDialog's own client-side check entirely -- must not be able to
// reach a state the real RPCs would reject.
describe('update event-time integrity (mirrors migration 0020)', () => {
  function baseUpdateInput(
    incident: { status: string; severity: string; ownerUserId: string | null; version: number },
    eventTime: string,
  ) {
    return {
      expectedVersion: incident.version,
      eventTime,
      actionsTaken: 'עדכון לצורך בדיקה',
      findings: '',
      nextSteps: '',
      currentStatusText: 'המצב הנוכחי לצורך בדיקה',
      status: incident.status,
      severity: incident.severity,
      changeReason: '',
      note: '',
      ownerUserId: incident.ownerUserId,
      updateReportedToOps: 'not_required',
      updateReportedToOpsRecipient: null,
      updateReportedToComms: 'no',
      updateReportedToCommsRecipient: null,
      updateWisdomReported: 'no',
    } as Parameters<LocalDemoRepository['updateIncident']>[2];
  }

  it('rejects an unparseable eventTime on a full update', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const incident = (await repo.getIncident(supervisor1, 'inc-2'))!;
    await expect(
      repo.updateIncident(supervisor1, 'inc-2', baseUpdateInput(incident, 'not-a-timestamp')),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects an eventTime before the incident was discovered on a full update', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const incident = (await repo.getIncident(supervisor1, 'inc-2'))!;
    const tooEarly = new Date(new Date(incident.discoveredAt).getTime() - 60_000).toISOString();
    await expect(
      repo.updateIncident(supervisor1, 'inc-2', baseUpdateInput(incident, tooEarly)),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects an eventTime beyond now + 5 minutes on a full update', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const incident = (await repo.getIncident(supervisor1, 'inc-2'))!;
    const tooLate = new Date(FIXED_NOW.getTime() + 10 * 60_000).toISOString();
    await expect(
      repo.updateIncident(supervisor1, 'inc-2', baseUpdateInput(incident, tooLate)),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('accepts an eventTime exactly at discoveredAt or exactly at now + 5 minutes (inclusive bounds)', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const incident = (await repo.getIncident(supervisor1, 'inc-2'))!;
    await expect(
      repo.updateIncident(supervisor1, 'inc-2', baseUpdateInput(incident, incident.discoveredAt)),
    ).resolves.toMatchObject({ version: incident.version + 1 });

    const incidentAgain = (await repo.getIncident(supervisor1, 'inc-2'))!;
    const upperBound = new Date(FIXED_NOW.getTime() + 5 * 60_000).toISOString();
    await expect(
      repo.updateIncident(supervisor1, 'inc-2', baseUpdateInput(incidentAgain, upperBound)),
    ).resolves.toMatchObject({ version: incidentAgain.version + 1 });
  });

  it('rejects an unparseable, too-early, or too-late eventTime on a technician update, independent of the ownership check', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const incident = (await repo.getIncident(tech1, 'inc-1'))!; // owned by tech1 in seed
    const tooEarly = new Date(new Date(incident.discoveredAt).getTime() - 60_000).toISOString();
    const tooLate = new Date(FIXED_NOW.getTime() + 10 * 60_000).toISOString();

    await expect(
      repo.technicianUpdate(tech1, 'inc-1', {
        expectedVersion: incident.version,
        eventTime: 'abc123',
        actionsTaken: 'בדיקה',
        findings: '',
        nextSteps: '',
        currentStatusText: 'המצב הנוכחי לצורך בדיקה',
        note: '',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      repo.technicianUpdate(tech1, 'inc-1', {
        expectedVersion: incident.version,
        eventTime: tooEarly,
        actionsTaken: 'בדיקה',
        findings: '',
        nextSteps: '',
        currentStatusText: 'המצב הנוכחי לצורך בדיקה',
        note: '',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      repo.technicianUpdate(tech1, 'inc-1', {
        expectedVersion: incident.version,
        eventTime: tooLate,
        actionsTaken: 'בדיקה',
        findings: '',
        nextSteps: '',
        currentStatusText: 'המצב הנוכחי לצורך בדיקה',
        note: '',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('Chapter 2 terminal-status compatibility', () => {
  // Predates the cancellation vertical slice's own cancelIncident action
  // (see the "cancellation requirements" describe block above): this
  // fixture seeds a cancelled incident directly into storage, exactly as
  // historical or externally inserted data would arrive, to prove the
  // read/filter logic (isOpen, openOnly) treats it as terminal independent
  // of how it got that status.
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

  it('terminalOnly (the archive scope) includes both closed and cancelled incidents, excludes open ones', async () => {
    const storage = new MemoryStorage();
    const seeded = buildSeed(FIXED_NOW);
    const cancelledTarget = seeded.incidents.find((i) => i.id === 'inc-2')!;
    cancelledTarget.status = 'cancelled';
    storage.save(seeded);
    const repo = new LocalDemoRepository(storage, { now: () => FIXED_NOW });

    const archived = await repo.listIncidents(supervisor1, { terminalOnly: true });
    expect(archived.every((i) => i.status === 'closed' || i.status === 'cancelled')).toBe(true);
    expect(archived.some((i) => i.status === 'closed')).toBe(true); // inc-5/inc-6, seeded closed
    expect(archived.some((i) => i.id === 'inc-2' && i.status === 'cancelled')).toBe(true);
    expect(archived.some((i) => i.id === 'inc-1')).toBe(false); // inc-1 stays open (in_progress)
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

describe('renaming personnel (mirrors migration 0034 rules)', () => {
  let repo: LocalDemoRepository;
  beforeEach(() => {
    repo = newRepo({ now: FIXED_NOW });
  });

  describe('already-linked profiles (active or inactive)', () => {
    it('shift_supervisor renames an active technician within ceiling', async () => {
      await repo.renameLinkedPersonnel(supervisor1, DEMO_USERS.tech1, { fullName: 'שם חדש' });
      const profile = await repo.getProfile(DEMO_USERS.tech1);
      expect(profile).toMatchObject({ fullName: 'שם חדש' });
    });

    it('renames an INACTIVE profile just as well as an active one', async () => {
      await repo.setUserActive(admin, DEMO_USERS.tech2, false);
      await repo.renameLinkedPersonnel(admin, DEMO_USERS.tech2, { fullName: 'טכנאי לא פעיל חדש' });
      const profile = await repo.getProfile(DEMO_USERS.tech2);
      expect(profile).toMatchObject({ fullName: 'טכנאי לא פעיל חדש', active: false });
    });

    it('rejects renaming a permanently deleted (tombstoned) profile', async () => {
      // supervisor2 owns no open incidents in the seed data, so it can be
      // tombstoned cleanly to set up this case.
      await repo.deleteUser(admin, DEMO_USERS.supervisor2);
      await expect(
        repo.renameLinkedPersonnel(admin, DEMO_USERS.supervisor2, { fullName: 'שם אחרי מחיקה' }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('role-ceiling rejection: shift_supervisor cannot rename a professional_manager', async () => {
      await expect(
        repo.renameLinkedPersonnel(supervisor1, DEMO_USERS.manager, { fullName: 'שם חדש' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('system_admin, professional_manager and shift_supervisor may all rename THEMSELVES', async () => {
      await expect(
        repo.renameLinkedPersonnel(admin, DEMO_USERS.admin, { fullName: 'שם עצמי חדש' }),
      ).resolves.toBeUndefined();
      await expect(
        repo.renameLinkedPersonnel(manager, DEMO_USERS.manager, { fullName: 'שם עצמי חדש 2' }),
      ).resolves.toBeUndefined();
      await expect(
        repo.renameLinkedPersonnel(supervisor1, DEMO_USERS.supervisor1, { fullName: 'שם עצמי חדש 3' }),
      ).resolves.toBeUndefined();
      const profile = await repo.getProfile(DEMO_USERS.admin);
      expect(profile).toMatchObject({ fullName: 'שם עצמי חדש' });
    });

    it('a self-rename is audited as user_renamed, just like renaming someone else', async () => {
      await repo.renameLinkedPersonnel(admin, DEMO_USERS.admin, { fullName: 'שם עצמי חדש' });
      const logs = await repo.listAuditLogs(admin, {});
      const entry = logs.find((l) => l.action === 'user_renamed' && l.entityId === DEMO_USERS.admin);
      expect(entry).toBeTruthy();
    });

    it('technician and viewer cannot rename themselves or anyone else', async () => {
      await expect(repo.renameLinkedPersonnel(tech1, DEMO_USERS.tech1, { fullName: 'שם חדש' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(repo.renameLinkedPersonnel(viewer, DEMO_USERS.viewer, { fullName: 'שם חדש' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(repo.renameLinkedPersonnel(tech1, DEMO_USERS.tech2, { fullName: 'שם חדש' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('renaming someone ELSE still respects the existing role ceiling -- a professional_manager cannot rename a peer professional_manager', async () => {
      await repo.setUserRole(admin, DEMO_USERS.tech2, 'professional_manager');
      await expect(
        repo.renameLinkedPersonnel(manager, DEMO_USERS.tech2, { fullName: 'שם חדש' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rejects a blank name', async () => {
      await expect(
        repo.renameLinkedPersonnel(admin, DEMO_USERS.tech1, { fullName: '   ' }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('rejects a 1-character name (below the 2-character minimum)', async () => {
      await expect(
        repo.renameLinkedPersonnel(admin, DEMO_USERS.tech1, { fullName: 'א' }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('rejects a name over 60 characters', async () => {
      await expect(
        repo.renameLinkedPersonnel(admin, DEMO_USERS.tech1, { fullName: 'א'.repeat(61) }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('rejects a name with an embedded newline or control character', async () => {
      await expect(
        repo.renameLinkedPersonnel(admin, DEMO_USERS.tech1, { fullName: 'Name\nWith Newline' }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        repo.renameLinkedPersonnel(admin, DEMO_USERS.tech1, { fullName: 'Name\tWith Tab' }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('accepts ordinary Unicode display names: Hebrew with parentheses, plain English, and hyphen/apostrophe', async () => {
      await expect(
        repo.renameLinkedPersonnel(admin, DEMO_USERS.tech1, { fullName: 'עומר פרץ (דמו)' }),
      ).resolves.toBeUndefined();
      await expect(
        repo.renameLinkedPersonnel(admin, DEMO_USERS.tech1, { fullName: 'Martin Gusin' }),
      ).resolves.toBeUndefined();
      await expect(
        repo.renameLinkedPersonnel(admin, DEMO_USERS.tech2, { fullName: "Mary-Jane O'Neil" }),
      ).resolves.toBeUndefined();
    });

    it('is audited as user_renamed', async () => {
      await repo.renameLinkedPersonnel(admin, DEMO_USERS.tech1, { fullName: 'שם חדש' });
      const logs = await repo.listAuditLogs(admin, {});
      expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['user_renamed']));
    });
  });

  describe('pending entries', () => {
    const input = (over: Partial<{ fullName: string; email: string; role: Session['role'] }> = {}) => ({
      fullName: 'ממתין לבדיקה',
      email: 'pending.rename@example.com',
      role: 'technician' as Session['role'],
      ...over,
    });

    it('shift_supervisor renames a pending technician entry within ceiling', async () => {
      const entry = await repo.createPendingPersonnel(supervisor1, input());
      const renamed = await repo.renamePendingPersonnel(supervisor1, entry.id, { fullName: 'שם עודכן' });
      expect(renamed).toMatchObject({ fullName: 'שם עודכן', email: 'pending.rename@example.com' });
    });

    it('role-ceiling rejection: shift_supervisor cannot rename a pending professional_manager entry', async () => {
      const entry = await repo.createPendingPersonnel(admin, input({ role: 'professional_manager' }));
      await expect(
        repo.renamePendingPersonnel(supervisor1, entry.id, { fullName: 'שם חדש' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('only a still-pending entry can be renamed -- a cancelled entry is rejected', async () => {
      const entry = await repo.createPendingPersonnel(supervisor1, input());
      await repo.cancelPendingPersonnel(supervisor1, entry.id);
      await expect(
        repo.renamePendingPersonnel(supervisor1, entry.id, { fullName: 'שם חדש' }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('rejects invalid names the same way as a linked-profile rename', async () => {
      const entry = await repo.createPendingPersonnel(supervisor1, input());
      await expect(
        repo.renamePendingPersonnel(supervisor1, entry.id, { fullName: '  ' }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        repo.renamePendingPersonnel(supervisor1, entry.id, { fullName: 'a'.repeat(61) }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        repo.renamePendingPersonnel(supervisor1, entry.id, { fullName: 'Broken\nName' }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('accepts ordinary Unicode display names -- the character allowlist is gone', async () => {
      const entry = await repo.createPendingPersonnel(supervisor1, input());
      await expect(
        repo.renamePendingPersonnel(supervisor1, entry.id, { fullName: 'עומר פרץ (דמו)' }),
      ).resolves.toMatchObject({ fullName: 'עומר פרץ (דמו)' });
    });

    it('the renamed value is what claimPendingForIdentity uses -- the original name never surfaces again', async () => {
      const entry = await repo.createPendingPersonnel(supervisor1, input());
      await repo.renamePendingPersonnel(supervisor1, entry.id, { fullName: 'שם אחרי שינוי' });
      const profile = repo.claimPendingForIdentity({ authUserId: 'auth-rename-1', email: 'pending.rename@example.com' });
      expect(profile).toMatchObject({ fullName: 'שם אחרי שינוי' });
    });

    it('a manually admin-renamed profile is never reverted by a later claim (re-login)', async () => {
      await repo.createPendingPersonnel(supervisor1, input());
      const claimed = repo.claimPendingForIdentity({ authUserId: 'auth-rename-2', email: 'pending.rename@example.com' });
      expect(claimed).toMatchObject({ fullName: 'ממתין לבדיקה' });

      await repo.renameLinkedPersonnel(admin, 'auth-rename-2', { fullName: 'שם שונה ידנית על ידי מנהל' });

      // A second "login" for the SAME identity must return the existing
      // profile untouched -- never re-reading (or reverting to) the
      // pending row's original name.
      const reclaimed = repo.claimPendingForIdentity({ authUserId: 'auth-rename-2', email: 'pending.rename@example.com' });
      expect(reclaimed).toMatchObject({ fullName: 'שם שונה ידנית על ידי מנהל' });
    });

    it('is audited as personnel_pending_renamed', async () => {
      const entry = await repo.createPendingPersonnel(supervisor1, input());
      await repo.renamePendingPersonnel(supervisor1, entry.id, { fullName: 'שם עודכן' });
      // view_audit_full (not just view_audit_incidents) is required to see
      // non-incident audit entries -- use admin, mirroring the linked-
      // profile audit assertion above.
      const logs = await repo.listAuditLogs(admin, {});
      expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['personnel_pending_renamed']));
    });
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

describe('reference-data management parity (migration 0024)', () => {
  it('creates trimmed systems and locations at the deterministic end of their category', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const system = await repo.createSystem(admin, '  מערכת חדשה  ', 'platforms');
    const location = await repo.createLocation(admin, '  מערכת חדשה  ', 'unit_internal');

    expect(system.name).toBe('מערכת חדשה');
    expect(location.name).toBe('מערכת חדשה'); // separate namespaces
    const systemsInCategory = (await repo.listSystems()).filter((s) => s.category === 'platforms');
    const locationsInCategory = (await repo.listLocations()).filter((l) => l.category === 'unit_internal');
    expect(systemsInCategory.at(-1)).toMatchObject({ id: system.id, displayOrder: system.displayOrder });
    expect(locationsInCategory.at(-1)).toMatchObject({ id: location.id, displayOrder: location.displayOrder });

    const logs = await repo.listAuditLogs(admin, {});
    expect(logs.some((log) => log.action === 'system_created' && log.entityId === system.id)).toBe(true);
    expect(logs.some((log) => log.action === 'location_created' && log.entityId === location.id)).toBe(true);
  });

  it('rejects unauthorized and inactive administrators authoritatively', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    await expect(repo.createSystem(supervisor1, 'אסור', 'other')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(repo.createLocation(viewer, 'אסור', 'other')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const storage = new MemoryStorage();
    const seeded = buildSeed(FIXED_NOW);
    seeded.profiles.find((profile) => profile.id === DEMO_USERS.admin)!.active = false;
    storage.save(seeded);
    const inactiveRepo = new LocalDemoRepository(storage, { now: () => FIXED_NOW });
    await expect(inactiveRepo.createSystem(admin, 'אסור', 'other')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects empty, whitespace-only, and overlong names', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    await expect(repo.createSystem(admin, '', 'other')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(repo.createLocation(admin, '   ', 'other')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(repo.createSystem(admin, 'א'.repeat(121), 'other')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('reserves normalized names globally, including inactive rows, while keeping namespaces separate', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const system = await repo.createSystem(admin, 'Control Alpha', 'other');
    await repo.setSystemArchived(admin, system.id, true);

    await expect(repo.createSystem(admin, '  control alpha  ', 'other')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('להפעיל מחדש'),
    });
    await expect(repo.createLocation(admin, 'CONTROL ALPHA', 'other')).resolves.toMatchObject({ name: 'CONTROL ALPHA' });
    await expect(repo.createLocation(admin, ' control alpha ', 'other')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('להפעיל מחדש'),
    });
  });

  it('renames without changing the stable id and rejects a normalized duplicate or missing id', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const record = await repo.createSystem(admin, 'שם לפני', 'other');
    await repo.renameSystem(admin, record.id, '  שם אחרי  ');

    expect((await repo.listSystems()).find((system) => system.id === record.id)?.name).toBe('שם אחרי');
    await expect(repo.renameSystem(admin, record.id, ' מערכת אלפא ')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(repo.renameLocation(admin, 'missing', 'שם')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('sorts equal order values deterministically within a category and safely moves up/down at every boundary', async () => {
    const storage = new MemoryStorage();
    const seeded = buildSeed(FIXED_NOW);
    // sys-beta and sys-pos-a are both seeded in the 'station_systems'
    // category (see seed.ts) -- an equal displayOrder here is a genuine
    // same-category tie, unlike setting it across every system regardless
    // of category, which per-category ordering makes meaningless.
    for (const system of seeded.systems) {
      if (system.category === 'station_systems') system.displayOrder = 50;
    }
    storage.save(seeded);
    const repo = new LocalDemoRepository(storage, { now: () => FIXED_NOW });

    const stationSystems = () => repo.listSystems().then((all) => all.filter((s) => s.category === 'station_systems'));
    const firstRead = (await stationSystems()).map((system) => system.id);
    expect((await stationSystems()).map((system) => system.id)).toEqual(firstRead);

    const firstId = firstRead[0];
    await repo.moveSystem(admin, firstId, 'up');
    expect((await stationSystems())[0].id).toBe(firstId);

    const secondId = (await stationSystems())[1].id;
    await repo.moveSystem(admin, secondId, 'up');
    expect((await stationSystems())[0].id).toBe(secondId);
    await repo.moveSystem(admin, secondId, 'down');
    expect((await stationSystems())[1].id).toBe(secondId);

    const locations = (await repo.listLocations()).filter((l) => l.category === 'unit_internal');
    const lastId = locations.at(-1)!.id;
    const unitLocations = () => repo.listLocations().then((all) => all.filter((l) => l.category === 'unit_internal'));
    await repo.moveLocation(admin, lastId, 'down');
    expect((await unitLocations()).at(-1)!.id).toBe(lastId);
    await repo.moveLocation(admin, lastId, 'up');
    expect((await unitLocations()).at(-2)!.id).toBe(lastId);
  });

  it("never changes another category's display order when moving a record", async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const computingBefore = (await repo.listSystems()).find((s) => s.category === 'computing')!;
    const infraBefore = (await repo.listSystems()).find((s) => s.category === 'infrastructure')!;

    await repo.moveSystem(admin, 'sys-pos-a', 'up'); // station_systems only

    const computingAfter = (await repo.listSystems()).find((s) => s.id === computingBefore.id)!;
    const infraAfter = (await repo.listSystems()).find((s) => s.id === infraBefore.id)!;
    expect(computingAfter.displayOrder).toBe(computingBefore.displayOrder);
    expect(infraAfter.displayOrder).toBe(infraBefore.displayOrder);
  });

  it('deactivates selectors, preserves historical rendering, and reactivation restores availability', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    await repo.setSystemArchived(admin, 'sys-alpha', true);
    await repo.setLocationArchived(admin, 'loc-1', true);

    expect((await repo.listSystems()).find((system) => system.id === 'sys-alpha')).toMatchObject({
      archived: true,
      name: 'מערכת אלפא',
    });
    expect((await repo.listLocations()).find((location) => location.id === 'loc-1')).toMatchObject({
      archived: true,
      name: 'אתר 1',
    });
    expect((await repo.listIncidents(admin)).some((incident) => incident.systemId === 'sys-alpha')).toBe(true);
    await expect(repo.createIncident(supervisor1, baseCreateInput())).rejects.toMatchObject({
      code: 'VALIDATION',
      message: 'יש לבחור מערכת / עמדה פעילה.',
    });

    await repo.setSystemArchived(admin, 'sys-alpha', false);
    await repo.setLocationArchived(admin, 'loc-1', false);
    await expect(repo.createIncident(supervisor1, baseCreateInput())).resolves.toMatchObject({
      systemId: 'sys-alpha',
      locationId: 'loc-1',
    });
  });

  it('physically deletes never-used rows, frees their names, and archives referenced rows instead', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    const unusedSystem = await repo.createSystem(admin, 'זמני למחיקה', 'other');
    const unusedLocation = await repo.createLocation(admin, 'מיקום זמני למחיקה', 'other');

    await expect(repo.deleteSystem(admin, unusedSystem.id)).resolves.toBe('deleted');
    await expect(repo.deleteLocation(admin, unusedLocation.id)).resolves.toBe('deleted');
    const systemsAfterDelete = (await repo.listSystems()).filter((s) => s.category === 'other');
    const locationsAfterDelete = (await repo.listLocations()).filter((l) => l.category === 'other');
    expect(systemsAfterDelete.some((system) => system.id === unusedSystem.id)).toBe(false);
    expect(systemsAfterDelete.map((system) => system.displayOrder)).toEqual(
      systemsAfterDelete.map((_, index) => index + 1),
    );
    expect(locationsAfterDelete.map((location) => location.displayOrder)).toEqual(
      locationsAfterDelete.map((_, index) => index + 1),
    );
    await expect(repo.createSystem(admin, ' זמני למחיקה ', 'other')).resolves.toMatchObject({ name: 'זמני למחיקה' });
    await expect(repo.createLocation(admin, ' מיקום זמני למחיקה ', 'other')).resolves.toMatchObject({
      name: 'מיקום זמני למחיקה',
    });

    await expect(repo.deleteSystem(admin, 'sys-alpha')).resolves.toBe('archived');
    await expect(repo.deleteLocation(admin, 'loc-1')).resolves.toBe('archived');
    expect((await repo.listSystems()).find((system) => system.id === 'sys-alpha')?.archived).toBe(true);
    expect((await repo.listLocations()).find((location) => location.id === 'loc-1')?.archived).toBe(true);
    expect((await repo.listIncidents(admin)).some((incident) => incident.systemId === 'sys-alpha')).toBe(true);
  });

  it('returns controlled not-found errors for deletion and move operations', async () => {
    const repo = newRepo({ now: FIXED_NOW });
    await expect(repo.deleteSystem(admin, 'missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(repo.deleteLocation(admin, 'missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(repo.moveSystem(admin, 'missing', 'up')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      repo.moveLocation(admin, 'loc-1', 'sideways' as 'up'),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  describe('batch drag-and-drop reorder (reorderSystems/reorderLocations)', () => {
    it('applies the exact submitted order in one call, scoped to one category, and persists it across a fresh instance (refresh parity)', async () => {
      const storage = new MemoryStorage();
      const repo = new LocalDemoRepository(storage, { now: () => FIXED_NOW });
      // sys-beta/sys-pos-a (station_systems) and loc-1/loc-control
      // (unit_internal) are the seeded categories with 2+ members.
      const systemIds = (await repo.listSystems())
        .filter((s) => s.category === 'station_systems')
        .map((s) => s.id);
      const reversed = [...systemIds].reverse();

      await repo.reorderSystems(admin, reversed);
      const stationSystems = () => repo.listSystems().then((all) => all.filter((s) => s.category === 'station_systems'));
      expect((await stationSystems()).map((s) => s.id)).toEqual(reversed);
      expect((await stationSystems()).map((s) => s.displayOrder)).toEqual(
        systemIds.map((_, index) => index + 1),
      );

      // A fresh repository instance backed by the same storage (simulating a
      // page refresh) must observe the exact same persisted order.
      const refreshed = new LocalDemoRepository(storage, { now: () => FIXED_NOW });
      expect(
        (await refreshed.listSystems()).filter((s) => s.category === 'station_systems').map((s) => s.id),
      ).toEqual(reversed);

      const locationIds = (await repo.listLocations())
        .filter((l) => l.category === 'unit_internal')
        .map((l) => l.id);
      const rotated = [...locationIds.slice(1), locationIds[0]];
      await repo.reorderLocations(admin, rotated);
      expect(
        (await repo.listLocations()).filter((l) => l.category === 'unit_internal').map((l) => l.id),
      ).toEqual(rotated);
    });

    it("never changes another category's display order when reordering one category", async () => {
      const repo = newRepo({ now: FIXED_NOW });
      const otherCategoriesBefore = (await repo.listSystems()).filter((s) => s.category !== 'station_systems');
      const stationIds = (await repo.listSystems())
        .filter((s) => s.category === 'station_systems')
        .map((s) => s.id);

      await repo.reorderSystems(admin, [...stationIds].reverse());

      const otherCategoriesAfter = (await repo.listSystems()).filter((s) => s.category !== 'station_systems');
      expect(otherCategoriesAfter).toEqual(otherCategoriesBefore);
    });

    it('rejects a cross-category id list without moving any record between categories', async () => {
      const repo = newRepo({ now: FIXED_NOW });
      const before = await repo.listSystems();
      // sys-alpha (platforms) + the two station_systems ids spans two
      // categories -- must be rejected, not silently treated as a
      // category change for sys-alpha.
      const stationIds = before.filter((s) => s.category === 'station_systems').map((s) => s.id);
      await expect(
        repo.reorderSystems(admin, ['sys-alpha', ...stationIds]),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(await repo.listSystems()).toEqual(before);
    });

    it('writes an audit entry for a successful reorder', async () => {
      const repo = newRepo({ now: FIXED_NOW });
      const systemIds = (await repo.listSystems())
        .filter((s) => s.category === 'station_systems')
        .map((s) => s.id);
      await repo.reorderSystems(admin, [...systemIds].reverse());
      const logs = await repo.listAuditLogs(admin, {});
      expect(logs.some((log) => log.action === 'systems_reordered')).toBe(true);
    });

    it('rejects unauthorized and inactive administrators authoritatively', async () => {
      const repo = newRepo({ now: FIXED_NOW });
      const systemIds = (await repo.listSystems())
        .filter((s) => s.category === 'station_systems')
        .map((s) => s.id);
      await expect(repo.reorderSystems(supervisor1, systemIds)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(repo.reorderLocations(viewer, [])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rejects empty, duplicated, incomplete, and unknown id lists without changing any order', async () => {
      const repo = newRepo({ now: FIXED_NOW });
      const before = await repo.listSystems();
      const systemIds = before.filter((s) => s.category === 'station_systems').map((s) => s.id);

      await expect(repo.reorderSystems(admin, [])).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        repo.reorderSystems(admin, [systemIds[0], systemIds[0]]),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(repo.reorderSystems(admin, systemIds.slice(1))).rejects.toMatchObject({
        code: 'VALIDATION',
      });
      await expect(repo.reorderSystems(admin, [...systemIds, 'unknown-id'])).rejects.toMatchObject({
        code: 'VALIDATION',
      });

      expect(await repo.listSystems()).toEqual(before);
    });
  });

  it('blocks reactivation when stale demo storage contains a legacy normalized conflict', async () => {
    const storage = new MemoryStorage();
    const seeded = buildSeed(FIXED_NOW);
    seeded.systems.push({
      id: 'legacy-duplicate',
      name: ' מערכת אלפא ',
      archived: true,
      category: 'other',
      displayOrder: 99,
      createdAt: FIXED_NOW.toISOString(),
    });
    storage.save(seeded);
    const repo = new LocalDemoRepository(storage, { now: () => FIXED_NOW });

    await expect(repo.setSystemArchived(admin, 'legacy-duplicate', false)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await repo.listSystems()).find((system) => system.id === 'legacy-duplicate')?.archived).toBe(true);
  });

  it('backfills old persisted demo rows with stable display orders without removing or renaming them', async () => {
    const storage = new MemoryStorage();
    const seeded = buildSeed(FIXED_NOW);
    delete seeded.referenceDataSchemaVersion;
    for (const record of [...seeded.systems, ...seeded.locations]) {
      delete (record as Partial<typeof record>).displayOrder;
    }
    const originalSystemIds = seeded.systems.map((system) => system.id).sort();
    storage.save(seeded);

    const repo = new LocalDemoRepository(storage, { now: () => FIXED_NOW });
    const systems = await repo.listSystems();
    expect(systems.map((system) => system.id).sort()).toEqual(originalSystemIds);
    expect(systems.every((system) => Number.isInteger(system.displayOrder) && system.displayOrder > 0)).toBe(true);
    // Schema version lands on 2 (not just 1): the order backfill runs first
    // and marks 1, then the category backfill immediately runs too (this
    // demo db predates categories entirely) and advances it to 2.
    expect(storage.load()?.referenceDataSchemaVersion).toBe(2);
  });

  it('backfills old persisted demo rows with category "other" without removing, renaming, or reordering them', async () => {
    const storage = new MemoryStorage();
    const seeded = buildSeed(FIXED_NOW);
    // Faithful pre-category snapshot: back then every system/location was one
    // single global list, so displayOrder was globally sequential -- not the
    // per-category values the current seed uses.
    seeded.systems.forEach((system, index) => {
      system.displayOrder = index + 1;
    });
    seeded.locations.forEach((location, index) => {
      location.displayOrder = index + 1;
    });
    seeded.referenceDataSchemaVersion = 1; // ordering already backfilled; category is not
    const originalSystems = seeded.systems.map((system) => ({ id: system.id, displayOrder: system.displayOrder, archived: system.archived }));
    const originalLocations = seeded.locations.map((location) => ({ id: location.id, displayOrder: location.displayOrder, archived: location.archived }));
    for (const record of [...seeded.systems, ...seeded.locations]) {
      delete (record as Partial<typeof record>).category;
    }
    storage.save(seeded);

    const repo = new LocalDemoRepository(storage, { now: () => FIXED_NOW });
    const systems = await repo.listSystems();
    const locations = await repo.listLocations();
    expect(systems.every((system) => system.category === 'other')).toBe(true);
    expect(locations.every((location) => location.category === 'other')).toBe(true);
    // ids, order, and active state are all untouched by the backfill.
    expect(
      systems.map((system) => ({ id: system.id, displayOrder: system.displayOrder, archived: system.archived })).sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([...originalSystems].sort((a, b) => a.id.localeCompare(b.id)));
    expect(
      locations.map((location) => ({ id: location.id, displayOrder: location.displayOrder, archived: location.archived })).sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([...originalLocations].sort((a, b) => a.id.localeCompare(b.id)));
    expect(storage.load()?.referenceDataSchemaVersion).toBe(2);
  });
});

describe('closed-incident count (countClosedIncidents)', () => {
  let repo: LocalDemoRepository;
  beforeEach(() => {
    repo = newRepo({ now: FIXED_NOW });
  });

  it('counts exactly the seeded closed incidents', async () => {
    // Seed has inc-5, inc-6, and inc-9 closed, and nothing cancelled.
    expect(await repo.countClosedIncidents(admin)).toBe(3);
  });

  it('never counts a cancelled incident', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    await repo.cancelIncident(supervisor1, 'inc-2', {
      expectedVersion: incident!.version,
      eventTime: FIXED_NOW.toISOString(),
      cancellationReason: 'נפתחה בטעות',
    });
    // The archive now holds four terminal incidents, but only three of them
    // are closed.
    const terminal = await repo.listIncidents(admin, { terminalOnly: true });
    expect(terminal.length).toBe(4);
    expect(await repo.countClosedIncidents(admin)).toBe(3);
  });

  it('follows closure and reopening', async () => {
    const before = await repo.countClosedIncidents(admin);
    const incident = await repo.getIncident(supervisor1, 'inc-1');
    const closed = await repo.closeIncident(supervisor1, 'inc-1', {
      expectedVersion: incident!.version,
      eventTime: FIXED_NOW.toISOString(),
      rootCause: 'תקלת חומרה',
      resolution: 'הוחלף רכיב',
      readiness: 'full',
      followUpNotes: '',
      reportedToOps: 'no',
    } as CloseIncidentInput);
    expect(await repo.countClosedIncidents(admin)).toBe(before + 1);

    await repo.reopenIncident(manager, 'inc-1', {
      expectedVersion: closed.version,
      reason: 'התקלה חזרה',
      nextUpdateDue: new Date(FIXED_NOW.getTime() + 3600_000).toISOString(),
      ownerUserId: DEMO_USERS.tech1,
    } as ReopenIncidentInput);
    expect(await repo.countClosedIncidents(admin)).toBe(before);
  });

  it('is not derived from the incident list, so it is unaffected by list filters or paging', async () => {
    // A caller-supplied filter narrows listIncidents but must never narrow
    // the total.
    const oneOnly = await repo.listIncidents(admin, { terminalOnly: true, severity: ['high'] });
    expect(oneOnly.length).toBeLessThan(2);
    expect(await repo.countClosedIncidents(admin)).toBe(3);
  });

  it('requires the view capability, exactly like every other incident read', async () => {
    const stranger = session('u-not-a-user', 'viewer');
    await expect(repo.countClosedIncidents(stranger)).rejects.toThrow(AppError);
  });
});

describe('incident_events.operationId grouping (mirrors migrations 0025/0026)', () => {
  let repo: LocalDemoRepository;
  beforeEach(() => {
    repo = newRepo({ now: FIXED_NOW });
  });

  function baseUpdateInput(overrides: Partial<UpdateIncidentInput> = {}): UpdateIncidentInput {
    return {
      expectedVersion: 3,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'בוצעה בדיקה',
      findings: '',
      nextSteps: '',
      currentStatusText: 'המצב הנוכחי לצורך בדיקה',
      status: 'in_progress',
      severity: 'critical',
      changeReason: '',
      note: '',
      ownerUserId: DEMO_USERS.tech1,
      updateReportedToOps: 'not_required',
      updateReportedToOpsRecipient: null,
      updateReportedToComms: 'no',
      updateReportedToCommsRecipient: null,
      updateWisdomReported: 'no',
      ...overrides,
    };
  }

  it('updateIncident: every row a single call inserts (update + every changed field) shares one operationId', async () => {
    // operational_impact is no longer editable via update_incident (PR B),
    // and update-specific reporting (migration 0031) is stored directly on
    // the incident_updates row rather than producing its own event -- so
    // three remaining protected fields (status, severity, owner) plus the
    // unconditional 'update' row itself: 4 rows total.
    await repo.updateIncident(
      supervisor1,
      'inc-1',
      baseUpdateInput({
        status: 'monitoring',
        severity: 'high',
        ownerUserId: DEMO_USERS.tech2,
        updateReportedToOps: 'yes',
        updateReportedToOpsRecipient: 'יוסי מהמוקד',
      }),
    );
    const events = await repo.getIncidentEvents(supervisor1, 'inc-1');
    const thisCall = events.filter((e) =>
      ['update', 'status_change', 'severity_change', 'assignment_change'].includes(e.type)
      && e.eventTime === FIXED_NOW.toISOString(),
    );
    expect(thisCall.length).toBe(4);
    const operationIds = new Set(thisCall.map((e) => e.operationId));
    expect(operationIds.size).toBe(1);
    expect([...operationIds][0]).not.toBeNull();
  });

  it('two separate updateIncident calls on the same incident get two different operationIds', async () => {
    const first = await repo.updateIncident(supervisor1, 'inc-1', baseUpdateInput({ status: 'monitoring' }));
    const second = await repo.updateIncident(
      supervisor1,
      'inc-1',
      baseUpdateInput({ expectedVersion: first.version, status: 'waiting_test' }),
    );
    const events = await repo.getIncidentEvents(supervisor1, 'inc-1');
    // Scoped to eventTime === FIXED_NOW, which only the two calls just made
    // use -- the seeded historical 'update' events sit at earlier offsets
    // and must not be conflated with this call's own rows.
    const updates = events.filter(
      (e) => e.type === 'update' && e.refId && e.eventTime === FIXED_NOW.toISOString(),
    );
    const opIds = new Set(updates.map((e) => e.operationId));
    expect(updates.length).toBe(2);
    expect(opIds.size).toBe(2);
    expect(second.version).toBe(first.version + 1);
  });

  it('createIncident: created + status_change + reported_to_ops_change share one operationId', async () => {
    const incident = await repo.createIncident(
      supervisor1,
      baseCreateInput({ status: 'in_progress', reportedToOps: 'yes', reportedToOpsRecipient: 'יוסי מהמוקד' }),
    );
    const events = await repo.getIncidentEvents(supervisor1, incident.id);
    expect(events.length).toBe(3);
    const opIds = new Set(events.map((e) => e.operationId));
    expect(opIds.size).toBe(1);
    expect([...opIds][0]).not.toBeNull();
  });

  it('closeIncident: closed + reported_to_ops_change share one operationId', async () => {
    const incident = await repo.getIncident(supervisor1, 'inc-2');
    await repo.closeIncident(supervisor1, 'inc-2', {
      expectedVersion: incident!.version,
      eventTime: FIXED_NOW.toISOString(),
      rootCause: 'תקלת חומרה',
      resolution: 'הוחלף רכיב',
      readiness: 'full',
      followUpNotes: '',
      reportedToOps: 'yes',
      reportedToOpsRecipient: 'יוסי מהמוקד',
    } as CloseIncidentInput);
    const events = await repo.getIncidentEvents(supervisor1, 'inc-2');
    const thisCall = events.filter((e) => e.type === 'closed' || e.type === 'reported_to_ops_change');
    expect(thisCall.length).toBe(2);
    expect(new Set(thisCall.map((e) => e.operationId)).size).toBe(1);
  });

  it('createHandover: handover_included rows across multiple incidents share one operationId, distinct per call', async () => {
    const h1 = await repo.createHandover(supervisor1, {
      toUserId: DEMO_USERS.supervisor2,
      generalNote: '',
      itemNotes: {},
    });
    const events1 = await repo.getIncidentEvents(supervisor1, 'inc-1');
    const included1 = events1.filter((e) => e.type === 'handover_included' && e.refId === h1.id);
    expect(included1.length).toBe(1);
    const op1 = included1[0].operationId;
    expect(op1).not.toBeNull();

    const h2 = await repo.createHandover(supervisor1, {
      toUserId: DEMO_USERS.manager,
      generalNote: '',
      itemNotes: {},
    });
    const events2 = await repo.getIncidentEvents(supervisor1, 'inc-1');
    const included2 = events2.filter((e) => e.type === 'handover_included' && e.refId === h2.id);
    expect(included2.length).toBe(1);
    expect(included2[0].operationId).not.toBeNull();
    expect(included2[0].operationId).not.toBe(op1);
  });

  it('a historical seeded event reads back with operationId null', async () => {
    const events = await repo.getIncidentEvents(supervisor1, 'inc-1');
    const created = events.find((e) => e.id === 'ev-1-created');
    expect(created).toBeDefined();
    expect(created!.operationId).toBeNull();
  });
});

// "הערה נוספת" (migration 0038): an optional, ≤600-character user note on
// create/update/technician-update/close. Stored on a dedicated userNote
// column/field -- never mixed with or overwriting the generated note text
// (create's actions-taken/comms/WISDOM summary, close's root-cause/
// resolution summary) or the update-specific changeReason.
describe('note ("הערה נוספת", migration 0038)', () => {
  let repo: LocalDemoRepository;
  beforeEach(() => {
    repo = newRepo({ now: FIXED_NOW });
  });

  it('createIncident: note is optional -- an empty default note still succeeds with userNote null', async () => {
    const created = await repo.createIncident(supervisor1, baseCreateInput());
    const events = await repo.getIncidentEvents(supervisor1, created.id);
    const createdEvent = events.find((e) => e.type === 'created');
    expect(createdEvent!.userNote).toBeNull();
  });

  it('createIncident: a valid note persists under the "created" event without overwriting the generated note', async () => {
    const created = await repo.createIncident(supervisor1, baseCreateInput({ note: '  הערה על פתיחת התקלה  ' }));
    const events = await repo.getIncidentEvents(supervisor1, created.id);
    const createdEvent = events.find((e) => e.type === 'created');
    expect(createdEvent!.userNote).toBe('הערה על פתיחת התקלה');
    expect(createdEvent!.note).toContain('פעולות שבוצעו עד כה');
  });

  it('createIncident: blank/whitespace-only note is stored as null', async () => {
    const created = await repo.createIncident(supervisor1, baseCreateInput({ note: '   ' }));
    const events = await repo.getIncidentEvents(supervisor1, created.id);
    expect(events.find((e) => e.type === 'created')!.userNote).toBeNull();
  });

  it('updateIncident: a valid note persists on the incident_updates row, and two separate updates keep two separate notes', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-2');
    await repo.updateIncident(supervisor1, 'inc-2', {
      expectedVersion: before!.version,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'עדכון ראשון',
      findings: '',
      nextSteps: '',
      currentStatusText: 'המצב הנוכחי לצורך בדיקה',
      status: before!.status,
      severity: before!.severity,
      changeReason: '',
      note: 'הערה ראשונה',
      ownerUserId: before!.ownerUserId,
      updateReportedToOps: 'not_required',
      updateReportedToOpsRecipient: null,
      updateReportedToComms: 'no',
      updateReportedToCommsRecipient: null,
      updateWisdomReported: 'no',
    });
    const afterFirst = await repo.getIncident(supervisor1, 'inc-2');
    await repo.updateIncident(supervisor1, 'inc-2', {
      expectedVersion: afterFirst!.version,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'עדכון שני',
      findings: '',
      nextSteps: '',
      currentStatusText: 'המצב הנוכחי לצורך בדיקה',
      status: afterFirst!.status,
      severity: afterFirst!.severity,
      changeReason: '',
      note: 'הערה שנייה',
      ownerUserId: afterFirst!.ownerUserId,
      updateReportedToOps: 'not_required',
      updateReportedToOpsRecipient: null,
      updateReportedToComms: 'no',
      updateReportedToCommsRecipient: null,
      updateWisdomReported: 'no',
    });

    const updates = await repo.getIncidentUpdates(supervisor1, 'inc-2');
    const first = updates.find((u) => u.actionsTaken === 'עדכון ראשון');
    const second = updates.find((u) => u.actionsTaken === 'עדכון שני');
    expect(first!.userNote).toBe('הערה ראשונה');
    expect(second!.userNote).toBe('הערה שנייה');
  });

  it('updateIncident: blank/whitespace-only note is stored as null, without disturbing changeReason', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-4');
    await repo.updateIncident(supervisor1, 'inc-4', {
      expectedVersion: before!.version,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'בדיקה',
      findings: '',
      nextSteps: '',
      currentStatusText: 'המצב הנוכחי לצורך בדיקה',
      status: 'in_progress',
      severity: before!.severity,
      changeReason: 'סיבת השינוי',
      note: '   ',
      ownerUserId: before!.ownerUserId,
      updateReportedToOps: 'not_required',
      updateReportedToOpsRecipient: null,
      updateReportedToComms: 'no',
      updateReportedToCommsRecipient: null,
      updateWisdomReported: 'no',
    });
    const updates = await repo.getIncidentUpdates(supervisor1, 'inc-4');
    expect(updates[updates.length - 1].userNote).toBeNull();
    const events = await repo.getIncidentEvents(supervisor1, 'inc-4');
    const statusChanges = events.filter((e) => e.type === 'status_change' && e.field === 'status');
    expect(statusChanges[statusChanges.length - 1].note).toBe('סיבת השינוי');
  });

  it('technicianUpdate: a valid note persists without gaining any protected-field capability', async () => {
    const before = await repo.getIncident(tech1, 'inc-1');
    const updated = await repo.technicianUpdate(tech1, 'inc-1', {
      expectedVersion: before!.version,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'בדיקה טכנית',
      findings: '',
      nextSteps: '',
      currentStatusText: 'המצב הנוכחי לצורך בדיקה',
      note: '  הערה של הטכנאי  ',
    });
    // No protected field moved -- severity/status/owner are all unchanged.
    expect(updated.severity).toBe(before!.severity);
    expect(updated.status).toBe(before!.status);
    expect(updated.ownerUserId).toBe(before!.ownerUserId);

    const updates = await repo.getIncidentUpdates(tech1, 'inc-1');
    expect(updates[updates.length - 1].userNote).toBe('הערה של הטכנאי');
  });

  it('technicianUpdate: blank/whitespace-only note is stored as null', async () => {
    const before = await repo.getIncident(tech1, 'inc-1');
    await repo.technicianUpdate(tech1, 'inc-1', {
      expectedVersion: before!.version,
      eventTime: FIXED_NOW.toISOString(),
      actionsTaken: 'בדיקה טכנית',
      findings: '',
      nextSteps: '',
      currentStatusText: 'המצב הנוכחי לצורך בדיקה',
      note: '   ',
    });
    const updates = await repo.getIncidentUpdates(tech1, 'inc-1');
    expect(updates[updates.length - 1].userNote).toBeNull();
  });

  it('closeIncident (full readiness): note persists without overwriting the generated root-cause/resolution note', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-2');
    const closed = await repo.closeIncident(supervisor1, 'inc-2', {
      expectedVersion: before!.version,
      eventTime: FIXED_NOW.toISOString(),
      rootCause: 'סיבה',
      resolution: 'פתרון',
      readiness: 'full',
      followUpNotes: '',
      reportedToOps: 'no',
      note: '  הערה בעת סגירה מלאה  ',
    });
    const events = await repo.getIncidentEvents(supervisor1, closed.id);
    const closedEvent = events.find((e) => e.type === 'closed');
    expect(closedEvent!.userNote).toBe('הערה בעת סגירה מלאה');
    expect(closedEvent!.note).toContain('סיבת התקלה');
  });

  it('closeIncident (incomplete readiness): note persists on the status_change row without overwriting its generated note', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-3');
    const partial = await repo.closeIncident(supervisor1, 'inc-3', {
      expectedVersion: before!.version,
      eventTime: FIXED_NOW.toISOString(),
      rootCause: 'סיבה',
      resolution: 'פתרון חלקי',
      readiness: 'partial',
      followUpNotes: 'להשלים בהמשך',
      ownerUserId: DEMO_USERS.tech1,
      reportedToOps: 'no',
      note: 'הערה בעת סגירה חלקית',
    });
    expect(partial.status).toBe('partial_readiness');
    const events = await repo.getIncidentEvents(supervisor1, partial.id);
    const statusChange = events.find((e) => e.type === 'status_change' && e.newValue === 'partial_readiness');
    expect(statusChange!.userNote).toBe('הערה בעת סגירה חלקית');
    expect(statusChange!.note).toContain('סיבת התקלה');
  });

  it('closeIncident: blank/whitespace-only note is stored as null', async () => {
    const before = await repo.getIncident(supervisor1, 'inc-4');
    const closed = await repo.closeIncident(supervisor1, 'inc-4', {
      expectedVersion: before!.version,
      eventTime: FIXED_NOW.toISOString(),
      rootCause: 'סיבה',
      resolution: 'פתרון',
      readiness: 'full',
      followUpNotes: '',
      reportedToOps: 'no',
      note: '   ',
    });
    const events = await repo.getIncidentEvents(supervisor1, closed.id);
    expect(events.find((e) => e.type === 'closed')!.userNote).toBeNull();
  });
});

describe('listNotifications: historical update_overdue rows stay stored but excluded from the active result', () => {
  it('an unread historical update_overdue notification is neither returned nor counted, while a normal unread notification is unaffected', async () => {
    const storage = new MemoryStorage();
    const seeded = buildSeed(FIXED_NOW);
    // Seed already has one unread 'incident_assigned' notification for
    // tech1 (ntf-2). Inject a synthetic, unread, historical 'update_overdue'
    // row for the same user -- the next-update-ETA feature that produced
    // rows like this was removed, but a hosted database may still hold one.
    seeded.notifications.push({
      id: 'ntf-legacy-overdue',
      userId: DEMO_USERS.tech1,
      type: 'update_overdue',
      incidentId: 'inc-1',
      handoverId: null,
      text: 'עבר מועד העדכון לתקלה 2026-001.',
      read: false,
      createdAt: FIXED_NOW.toISOString(),
      dedupeKey: undefined,
    });
    storage.save(seeded);
    const repo = new LocalDemoRepository(storage, { now: () => FIXED_NOW });

    const notifications = await repo.listNotifications(tech1);
    expect(notifications.some((n) => n.type === 'update_overdue')).toBe(false);
    expect(notifications.some((n) => n.id === 'ntf-legacy-overdue')).toBe(false);

    // The normal unread notification (ntf-2) is still present and still counts.
    const unreadCount = notifications.filter((n) => !n.read).length;
    expect(notifications.some((n) => n.id === 'ntf-2' && !n.read)).toBe(true);
    // Exactly the seed's own pre-existing unread count for tech1 (1) --
    // the injected update_overdue row must not inflate it.
    expect(unreadCount).toBe(1);
  });

  it('the row survives in storage (never deleted), just excluded from the active list', async () => {
    const storage = new MemoryStorage();
    const seeded = buildSeed(FIXED_NOW);
    seeded.notifications.push({
      id: 'ntf-legacy-overdue',
      userId: DEMO_USERS.tech1,
      type: 'update_overdue',
      incidentId: 'inc-1',
      handoverId: null,
      text: 'עבר מועד העדכון לתקלה 2026-001.',
      read: false,
      createdAt: FIXED_NOW.toISOString(),
      dedupeKey: undefined,
    });
    storage.save(seeded);
    const repo = new LocalDemoRepository(storage, { now: () => FIXED_NOW });
    await repo.listNotifications(tech1);

    const raw = storage.load();
    expect(raw?.notifications.some((n) => n.id === 'ntf-legacy-overdue')).toBe(true);
  });
});
