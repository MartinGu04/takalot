// Central permission matrix. The data layer (local demo backend and Supabase RLS)
// enforces these rules; the UI only uses them to hide unavailable actions.
import type { Role, Incident, Profile } from './types';
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
  | 'manage_users'
  | 'manage_personnel'
  | 'manage_config'
  /** Read access to the system-wide audit log (יומן ביקורת) -- professional_manager
   *  and system_admin only, both at full parity (never a subset by entity type).
   *  Enforced independently at the database level (RLS + list_audit_events'
   *  own role check); this capability only controls frontend visibility. */
  | 'view_audit_log'
  | 'complete_follow_up'
  /** Post-creation management of explicit related-incident links (add or
   *  remove) -- אחמ״ש (shift_supervisor) and above. No existing capability
   *  covers exactly this role set (closest analogs, full_update/
   *  change_severity, are a different concept), so this is a narrowly
   *  scoped new capability rather than an overload of one of those.
   *  Creation-time linking (see the incident-creation flow) is deliberately
   *  NOT gated by this capability -- it's covered by create_incident plus a
   *  short server-enforced time window on the creator of that specific
   *  incident (link_incident_on_creation, migration 0050), never a standing
   *  permission. Real enforcement is the database RPC's own role check
   *  (manage_incident_relation); this only controls frontend visibility. */
  | 'manage_incident_relations'
  /** Personalize which ניתוחים (analytics) page modules are visible
   *  ("התאמת התצוגה") -- shift_supervisor and above, matching the database's
   *  own is_operational_role() exactly (migration 0052). No existing
   *  capability covers exactly this role set for the right reason (e.g.
   *  manage_personnel happens to match the same three roles, but is a
   *  different concept -- same reasoning manage_incident_relations above
   *  already used to justify its own narrowly-scoped capability rather than
   *  overloading an unrelated one). Real enforcement is the database's own
   *  RLS + set_my_analytics_visible_modules role check; this only controls
   *  whether the "התאמת התצוגה" affordance renders. */
  | 'personalize_analytics'
  /** Personalize per-event operational notification preferences (bell +
   *  Push) -- shift_supervisor and above, matching the database's own
   *  is_operational_role() exactly (migration 0058, AVARIA v1.6.0), the
   *  same role set as personalize_analytics but a distinct concept (this
   *  one is about notification delivery, not analytics page layout).
   *  Real enforcement is the database's own RLS + is_operational_role()
   *  check inside get_my_operational_notification_preferences /
   *  set_my_operational_notification_preference; this only controls
   *  whether the "עדכונים תפעוליים" section renders in the notification
   *  settings dialog. */
  | 'manage_operational_notification_preferences'
  /** Permanently, irreversibly delete an archived (closed/cancelled)
   *  incident and its entire live operational footprint from the database
   *  (AVARIA v1.7.0, migration 0059) -- system_admin ONLY, unlike every
   *  other capability above (all shared by at least two roles). A
   *  deliberately destructive, exceptional purge action, never a lifecycle
   *  action -- see admin_purge_incident. Real enforcement is entirely the
   *  database RPC's own independent auth.uid()/active/role check; this
   *  only controls whether the "מחיקה לצמיתות" item renders in
   *  IncidentDetailPage's "פעולות נוספות" menu. */
  | 'permanently_delete_incident';

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
    'manage_users',
    'manage_personnel',
    'manage_config',
    'view_audit_log',
    'complete_follow_up',
    'manage_incident_relations',
    'personalize_analytics',
    'manage_operational_notification_preferences',
    'permanently_delete_incident',
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
    'manage_personnel',
    'view_audit_log',
    'complete_follow_up',
    'manage_incident_relations',
    'personalize_analytics',
    'manage_operational_notification_preferences',
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
    'manage_personnel',
    'complete_follow_up',
    'manage_incident_relations',
    'personalize_analytics',
    'manage_operational_notification_preferences',
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

/** Roles eligible to be an incident's internal owner (בעל אחריות פנימי) --
 *  every operational role plus technician; viewer is excluded even when
 *  active. Mirrors assert_owner_valid's own role check (migration 0039) --
 *  the database remains authoritative, this exists so OwnerField (the
 *  single shared owner picker) can filter/group without duplicating the
 *  rule per call site. Order matches app_role/roleLabels declaration order
 *  and is also the group display order in OwnerField. */
export const ELIGIBLE_OWNER_ROLES: Role[] = [
  'system_admin',
  'professional_manager',
  'shift_supervisor',
  'technician',
];

/** Active, role-eligible profiles grouped by role (in ELIGIBLE_OWNER_ROLES
 *  order) and sorted alphabetically by fullName within each group, using a
 *  Hebrew-aware comparison -- matching the sort convention already used
 *  elsewhere in this codebase (e.g. localRepository.ts's own profile/
 *  reference-name sorts). A role with no eligible members is omitted
 *  entirely, never an empty group. This is the ONE place that filters/
 *  groups/sorts owner candidates -- every caller (OwnerField's internal-
 *  owner picker, and the incidents/archive assignee filters) renders from
 *  this shared grouping rather than reimplementing the rule. */
export function groupEligibleOwners(profiles: Profile[] | undefined): Array<{ role: Role; profiles: Profile[] }> {
  const byRole = new Map<Role, Profile[]>();
  for (const p of profiles ?? []) {
    if (!p.active || !ELIGIBLE_OWNER_ROLES.includes(p.role)) continue;
    const list = byRole.get(p.role);
    if (list) list.push(p);
    else byRole.set(p.role, [p]);
  }
  return ELIGIBLE_OWNER_ROLES.map((role) => ({ role, profiles: byRole.get(role) ?? [] }))
    .filter((group) => group.profiles.length > 0)
    .map((group) => ({
      role: group.role,
      profiles: [...group.profiles].sort((a, b) => a.fullName.localeCompare(b.fullName, 'he')),
    }));
}
