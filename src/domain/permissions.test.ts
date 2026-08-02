import { describe, expect, it } from 'vitest';
import { hasCapability, canTechnicianUpdate, allowedAssignRoles, allowedManageRoles, DEFAULT_POLICY } from './permissions';
import type { Incident, Role } from './types';

describe('role permission matrix', () => {
  it('grants full incident lifecycle capabilities to system_admin', () => {
    expect(hasCapability('system_admin', 'manage_users')).toBe(true);
    expect(hasCapability('system_admin', 'close_incident')).toBe(true);
    expect(hasCapability('system_admin', 'reopen_incident')).toBe(true);
    expect(hasCapability('system_admin', 'export_data')).toBe(true);
  });

  it('denies user/config management to professional_manager', () => {
    expect(hasCapability('professional_manager', 'manage_users')).toBe(false);
    expect(hasCapability('professional_manager', 'manage_config')).toBe(false);
    expect(hasCapability('professional_manager', 'close_incident')).toBe(true);
    expect(hasCapability('professional_manager', 'reopen_incident')).toBe(true);
  });

  it('denies shift_supervisor reopen unless the backend policy explicitly allows it', () => {
    expect(hasCapability('shift_supervisor', 'reopen_incident', DEFAULT_POLICY)).toBe(false);
    expect(hasCapability('shift_supervisor', 'reopen_incident', { ...DEFAULT_POLICY, allowSupervisorReopen: true })).toBe(true);
  });

  it('denies shift_supervisor user/config management', () => {
    expect(hasCapability('shift_supervisor', 'manage_users')).toBe(false);
    expect(hasCapability('shift_supervisor', 'manage_config')).toBe(false);
  });

  it('limits technician to technical_update plus the narrow create/close/assign slice, no severity/cancel/reopen/full_update/export', () => {
    expect(hasCapability('technician', 'technical_update')).toBe(true);
    expect(hasCapability('technician', 'full_update')).toBe(false);
    expect(hasCapability('technician', 'change_severity')).toBe(false);
    expect(hasCapability('technician', 'cancel_incident')).toBe(false);
    expect(hasCapability('technician', 'reopen_incident')).toBe(false);
    expect(hasCapability('technician', 'export_data')).toBe(false);
  });

  // Migration 0037: an active technician may create, close (either
  // readiness outcome) and reassign/change-handling-party on any
  // non-terminal incident, regardless of current owner -- narrow additions
  // to the RPCs' own permission checks, not a change to is_operational_role()
  // itself. cancel_incident, reopen_incident and full_update stay exactly
  // as before (see the test above and 'grants cancel_incident to exactly
  // the operational roles' below).
  it('grants technician the narrow create/close/assign slice added by migration 0037', () => {
    expect(hasCapability('technician', 'create_incident')).toBe(true);
    expect(hasCapability('technician', 'close_incident')).toBe(true);
    expect(hasCapability('technician', 'assign_incident')).toBe(true);
  });

  it('denies viewer mutation and export unless explicitly granted', () => {
    expect(hasCapability('viewer', 'full_update')).toBe(false);
    expect(hasCapability('viewer', 'technical_update')).toBe(false);
    expect(hasCapability('viewer', 'export_data')).toBe(false);
    const granted = { ...DEFAULT_POLICY, viewerExportUserIds: ['viewer-1'] };
    expect(hasCapability('viewer', 'export_data', granted, 'viewer-1')).toBe(true);
    expect(hasCapability('viewer', 'export_data', granted, 'viewer-2')).toBe(false);
  });

  // cancel_incident mirrors the backend's is_operational_role() set exactly
  // (migration 0017): system_admin, professional_manager, shift_supervisor --
  // never technician or viewer.
  it('grants cancel_incident to exactly the operational roles', () => {
    expect(hasCapability('system_admin', 'cancel_incident')).toBe(true);
    expect(hasCapability('professional_manager', 'cancel_incident')).toBe(true);
    expect(hasCapability('shift_supervisor', 'cancel_incident')).toBe(true);
    expect(hasCapability('technician', 'cancel_incident')).toBe(false);
    expect(hasCapability('viewer', 'cancel_incident')).toBe(false);
  });

  // create_incident is granted to the operational roles and, as of
  // migration 0037, to technician as well -- never to viewer.
  it('grants create_incident to the operational roles and technician, never viewer', () => {
    expect(hasCapability('system_admin', 'create_incident')).toBe(true);
    expect(hasCapability('professional_manager', 'create_incident')).toBe(true);
    expect(hasCapability('shift_supervisor', 'create_incident')).toBe(true);
    expect(hasCapability('technician', 'create_incident')).toBe(true);
    expect(hasCapability('viewer', 'create_incident')).toBe(false);
  });
});

describe('personnel role-ceiling matrix (strict hierarchy, mirrors 0008/0010)', () => {
  const ALL_ROLES: Role[] = ['system_admin', 'professional_manager', 'shift_supervisor', 'technician', 'viewer'];

  it('shift_supervisor may assign/manage only technician and viewer -- never a peer or higher', () => {
    expect(allowedAssignRoles('shift_supervisor')).toEqual(['technician', 'viewer']);
    expect(allowedManageRoles('shift_supervisor')).toEqual(['technician', 'viewer']);
  });

  it('professional_manager may assign/manage shift_supervisor, technician and viewer -- never a peer or system_admin', () => {
    expect(allowedAssignRoles('professional_manager')).toEqual(['shift_supervisor', 'technician', 'viewer']);
    expect(allowedManageRoles('professional_manager')).toEqual(['shift_supervisor', 'technician', 'viewer']);
  });

  it('system_admin may assign/manage every role, including another system_admin', () => {
    expect(allowedAssignRoles('system_admin')).toEqual(expect.arrayContaining(ALL_ROLES));
    expect(allowedManageRoles('system_admin')).toEqual(expect.arrayContaining(ALL_ROLES));
  });

  it('technician and viewer may assign/manage nobody', () => {
    expect(allowedAssignRoles('technician')).toEqual([]);
    expect(allowedManageRoles('technician')).toEqual([]);
    expect(allowedAssignRoles('viewer')).toEqual([]);
    expect(allowedManageRoles('viewer')).toEqual([]);
  });

  it('the assignment and management ceilings are independent functions with identical (but separately evolvable) matrices today', () => {
    for (const role of ALL_ROLES) {
      expect(allowedAssignRoles(role)).toEqual(allowedManageRoles(role));
    }
  });
});

function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'i1',
    number: '2026-001',
    version: 1,
    systemId: 'sys',
    locationId: 'loc',
    description: 'desc',
    severity: 'medium',
    status: 'in_progress',
    operationalImpact: 'impact',
    ownerUserId: 'tech-1',
    ownerExternalName: null,
    externalHandlerName: null,
    externalHandlerContactPerson: null,
    externalHandlerContactDetails: null,
    discoveredAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'sup-1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'sup-1',
    lastUpdateAt: '2026-01-01T00:00:00.000Z',
    nextUpdateDue: null,
    noDeadlineReason: 'x',
    reportedToOps: 'no',
    reportedToOpsRecipient: null,
    reportedToComms: false,
    reportedToCommsRecipient: null,
    wisdomReported: false,
    wisdomIncidentNumber: null,
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
    ...overrides,
  };
}

describe('technician update restrictions', () => {
  it('allows a technician to update an incident assigned to them', () => {
    const incident = makeIncident({ ownerUserId: 'tech-1' });
    expect(canTechnicianUpdate('tech-1', incident)).toBe(true);
  });

  it('denies a technician updating an incident assigned to someone else', () => {
    const incident = makeIncident({ ownerUserId: 'tech-2' });
    expect(canTechnicianUpdate('tech-1', incident)).toBe(false);
  });

  it('denies a technician updating a closed incident even if assigned to them', () => {
    const incident = makeIncident({ ownerUserId: 'tech-1', status: 'closed' });
    expect(canTechnicianUpdate('tech-1', incident)).toBe(false);
  });

  it('denies a technician updating a cancelled incident even if assigned to them (Chapter 2 terminal status)', () => {
    const incident = makeIncident({ ownerUserId: 'tech-1', status: 'cancelled' });
    expect(canTechnicianUpdate('tech-1', incident)).toBe(false);
  });
});
