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

/** Normalizes a stored analytics module-visibility preference against the
 *  CURRENTLY supported module keys, dropping anything no longer recognized
 *  -- e.g. a preference persisted (in the hosted DB, or an older demo/local
 *  snapshot) before a module was removed from this list, like the deleted
 *  'externalInvolvement'. `null` (no stored preference at all) passes
 *  through unchanged.
 *
 *  Applied at the READ boundary (useAnalyticsPreferences), so a legacy key
 *  can never reach rendering, the personalization dialog's draft state, or
 *  -- once the user next saves anything, even unrelated to the stale key --
 *  get persisted right back into storage. The remaining known keys are
 *  preserved exactly (order, membership); only unrecognized entries are
 *  stripped, so a mixed preference like ['trend', 'closures',
 *  'externalInvolvement'] normalizes to ['trend', 'closures'], never to
 *  the whole preference being discarded. */
export function normalizeAnalyticsModules(modules: readonly string[] | null): AnalyticsModuleKey[] | null {
  if (modules === null) return null;
  const known = new Set<string>(ANALYTICS_MODULE_KEYS);
  return modules.filter((m): m is AnalyticsModuleKey => known.has(m));
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
