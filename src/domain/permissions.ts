// Central permission matrix. The data layer (local demo backend and Supabase RLS)
// enforces these rules; the UI only uses them to hide unavailable actions.
import type { Role, Incident } from './types';
import { isOpen } from './types';

export type Capability =
  | 'view_all_incidents'
  | 'create_incident'
  | 'acknowledge_incident'
  | 'full_update' // update including protected fields (status/severity/impact/owner/deadline)
  | 'technical_update' // restricted update on assigned incidents only
  | 'assign_incident'
  | 'change_severity'
  | 'close_incident'
  | 'cancel_incident'
  | 'reopen_incident'
  | 'export_data'
  | 'create_handover'
  | 'accept_handover'
  | 'manage_users'
  | 'manage_personnel'
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
    'cancel_incident',
    'reopen_incident',
    'export_data',
    'create_handover',
    'accept_handover',
    'manage_users',
    'manage_personnel',
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
    'cancel_incident',
    'reopen_incident',
    'export_data',
    'create_handover',
    'accept_handover',
    'manage_personnel',
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
    'cancel_incident',
    'export_data',
    'create_handover',
    'accept_handover',
    'manage_personnel',
    'complete_follow_up',
    // 'reopen_incident' is granted only via PolicyFlags.allowSupervisorReopen
  ],
  technician: ['view_all_incidents', 'technical_update', 'create_incident', 'close_incident', 'assign_incident'],
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
 * Role ceilings: a STRICT hierarchy, not peer-level. Mirrors the database
 * (role_ceiling_allows_assign in 0008, role_ceiling_allows_manage in
 * 0010) -- the database is authoritative; this exists for the demo
 * backend and for hiding unavailable UI options.
 *
 *   shift_supervisor     -> technician, viewer
 *   professional_manager -> shift_supervisor, technician, viewer
 *   system_admin         -> every role, including system_admin
 *   technician / viewer  -> nothing
 *
 * Neither role may reach a PEER of the same rank (a shift_supervisor may
 * not assign/manage another shift_supervisor; a professional_manager may
 * not assign/manage another professional_manager) -- only system_admin
 * manages system_admin. `viewer` is included as a manageable lower role
 * for both non-admin ranks.
 *
 * Two DELIBERATELY SEPARATE helpers, even though their matrices are
 * currently identical: assignment (registering a NEW pending-personnel
 * entry) and management (editing the role / activating / deactivating an
 * ALREADY-LINKED profile) are different policies that may diverge later,
 * exactly as the database keeps role_ceiling_allows_assign and
 * role_ceiling_allows_manage as two separate functions rather than one
 * shared one.
 */
/** Roles a creator may assign to a NEW pending-personnel entry. Mirrors
 *  role_ceiling_allows_assign (0008). Kept as an independent function body
 *  from allowedManageRoles below -- not a shared helper -- so the two can
 *  be edited (and diverge) independently, exactly like their SQL
 *  counterparts. */
export function allowedAssignRoles(creator: Role): Role[] {
  switch (creator) {
    case 'system_admin':
      return ['system_admin', 'professional_manager', 'shift_supervisor', 'technician', 'viewer'];
    case 'professional_manager':
      return ['shift_supervisor', 'technician', 'viewer'];
    case 'shift_supervisor':
      return ['technician', 'viewer'];
    default:
      return [];
  }
}

/** Roles whose ALREADY-LINKED profile a manager may edit/deactivate.
 *  Mirrors role_ceiling_allows_manage (0010). Independent function body
 *  from allowedAssignRoles above -- see that function's comment. */
export function allowedManageRoles(actor: Role): Role[] {
  switch (actor) {
    case 'system_admin':
      return ['system_admin', 'professional_manager', 'shift_supervisor', 'technician', 'viewer'];
    case 'professional_manager':
      return ['shift_supervisor', 'technician', 'viewer'];
    case 'shift_supervisor':
      return ['technician', 'viewer'];
    default:
      return [];
  }
}

/** Technicians may add technical updates only to incidents assigned to them. */
export function canTechnicianUpdate(userId: string, incident: Incident): boolean {
  return incident.ownerUserId === userId && isOpen(incident.status);
}

/** Fields technicians may never change. */
export const PROTECTED_FIELDS = [
  'severity',
  'operational_impact',
  'owner',
  'status',
  'closure',
] as const;
