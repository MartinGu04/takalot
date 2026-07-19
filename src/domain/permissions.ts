// Central permission matrix. The data layer (local demo backend and Supabase RLS)
// enforces these rules; the UI only uses them to hide unavailable actions.
import type { Role, Incident } from './types';

export type Capability =
  | 'view_all_incidents'
  | 'create_incident'
  | 'acknowledge_incident'
  | 'full_update' // update including protected fields (status/severity/impact/owner/deadline)
  | 'technical_update' // restricted update on assigned incidents only
  | 'assign_incident'
  | 'change_severity'
  | 'close_incident'
  | 'reopen_incident'
  | 'export_data'
  | 'create_handover'
  | 'accept_handover'
  | 'manage_users'
  | 'manage_config'
  | 'view_audit_full'
  | 'view_audit_incidents'
  | 'complete_follow_up';

/**
 * Backend policy flags. In demo mode these mirror what would be secure
 * backend configuration; they are never a hidden frontend switch.
 */
export interface PolicyFlags {
  /** shift_supervisor may reopen closed incidents only when explicitly allowed. */
  allowSupervisorReopen: boolean;
  /** viewer export requires an explicit backend capability grant. */
  viewerExportUserIds: string[];
}

export const DEFAULT_POLICY: PolicyFlags = {
  allowSupervisorReopen: false,
  viewerExportUserIds: [],
};

const matrix: Record<Role, Capability[]> = {
  system_admin: [
    'view_all_incidents',
    'create_incident',
    'acknowledge_incident',
    'full_update',
    'assign_incident',
    'change_severity',
    'close_incident',
    'reopen_incident',
    'export_data',
    'create_handover',
    'accept_handover',
    'manage_users',
    'manage_config',
    'view_audit_full',
    'view_audit_incidents',
    'complete_follow_up',
  ],
  professional_manager: [
    'view_all_incidents',
    'create_incident',
    'acknowledge_incident',
    'full_update',
    'assign_incident',
    'change_severity',
    'close_incident',
    'reopen_incident',
    'export_data',
    'create_handover',
    'accept_handover',
    'view_audit_incidents',
    'complete_follow_up',
  ],
  shift_supervisor: [
    'view_all_incidents',
    'create_incident',
    'acknowledge_incident',
    'full_update',
    'assign_incident',
    'change_severity',
    'close_incident',
    'export_data',
    'create_handover',
    'accept_handover',
    'complete_follow_up',
    // 'reopen_incident' is granted only via PolicyFlags.allowSupervisorReopen
  ],
  technician: ['view_all_incidents', 'technical_update'],
  viewer: ['view_all_incidents'],
};

export function hasCapability(
  role: Role,
  cap: Capability,
  policy: PolicyFlags = DEFAULT_POLICY,
  userId?: string,
): boolean {
  if (matrix[role].includes(cap)) return true;
  if (cap === 'reopen_incident' && role === 'shift_supervisor') {
    return policy.allowSupervisorReopen;
  }
  if (cap === 'export_data' && role === 'viewer' && userId) {
    return policy.viewerExportUserIds.includes(userId);
  }
  return false;
}

/**
 * Role ceilings for pre-provisioned personnel entries. Mirrors the database
 * rule (role_ceiling_allows in 0008) -- the database is authoritative; this
 * exists for the demo backend and for hiding unavailable UI options:
 *   shift_supervisor     -> technician, shift_supervisor
 *   professional_manager -> + professional_manager (NCO)
 *   system_admin         -> every role, including system_admin
 *   technician / viewer  -> nothing
 */
export function allowedPendingRoles(creator: Role): Role[] {
  switch (creator) {
    case 'system_admin':
      return ['system_admin', 'professional_manager', 'shift_supervisor', 'technician', 'viewer'];
    case 'professional_manager':
      return ['professional_manager', 'shift_supervisor', 'technician'];
    case 'shift_supervisor':
      return ['shift_supervisor', 'technician'];
    default:
      return [];
  }
}

/** Technicians may add technical updates only to incidents assigned to them. */
export function canTechnicianUpdate(userId: string, incident: Incident): boolean {
  return incident.ownerUserId === userId && incident.status !== 'closed';
}

/** Fields technicians may never change. */
export const PROTECTED_FIELDS = [
  'severity',
  'operational_impact',
  'owner',
  'status',
  'next_update_due',
  'closure',
] as const;
