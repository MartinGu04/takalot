// Personalized analytics module visibility ("התאמת התצוגה") -- role
// defaults and eligibility. Backed by user_analytics_preferences +
// set_my_analytics_visible_modules (migration 0052), which enforce
// ELIGIBILITY server-side (RLS + is_operational_role()); this file only
// supplies the frontend-only STARTING state each eligible role sees before
// they first customize -- a pure convenience with no security implication,
// since every eligible role can already toggle to any accepted module
// combination via the RPC. See that migration's header for the full split.
import type { Role } from './types';

export type AnalyticsModuleKey = 'trend' | 'ageDistribution' | 'topSystems' | 'topLocations' | 'closures';

export const ANALYTICS_MODULE_KEYS: AnalyticsModuleKey[] = [
  'trend',
  'ageDistribution',
  'topSystems',
  'topLocations',
  'closures',
];

/** Roles that may personalize their analytics view at all -- must match
 *  is_operational_role() exactly (system_admin/professional_manager/
 *  shift_supervisor). viewer/technician always see the full fixed module
 *  set, with no "התאמת התצוגה" affordance rendered for them at all. */
export const ANALYTICS_PERSONALIZATION_ROLES: Role[] = ['system_admin', 'professional_manager', 'shift_supervisor'];

export function canPersonalizeAnalytics(role: Role): boolean {
  return ANALYTICS_PERSONALIZATION_ROLES.includes(role);
}

/** Starting module set for a role that has never customized their view
 *  (no stored user_analytics_preferences row). Matches each role's stated
 *  operational focus: a shift_supervisor cares mainly about backlog/age/
 *  trend (their open-backlog KPI is already always-visible; severity is a
 *  filter, not a module); a professional_manager cares mainly about
 *  systems/locations/causes/treatment outcomes (their resolution-time KPI
 *  is likewise already always-visible); a system_admin ("department
 *  commander wants the complete page") starts with everything on. Ineligible
 *  roles fall back to the full set too, since they have no personalization
 *  UI to narrow it with. */
export function defaultAnalyticsModules(role: Role): AnalyticsModuleKey[] {
  switch (role) {
    case 'shift_supervisor':
      return ['trend', 'ageDistribution'];
    case 'professional_manager':
      return ['topSystems', 'topLocations', 'closures'];
    case 'system_admin':
      return [...ANALYTICS_MODULE_KEYS];
    default:
      return [...ANALYTICS_MODULE_KEYS];
  }
}
