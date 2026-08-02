// Internal owner picker: every actively managed incident requires a valid,
// active internal owner. External handling is a separate, additive concept
// -- see ExternalPartyFields -- never a substitute shown in this control.
//
// Eligibility mirrors assert_owner_valid's role check (migration 0039):
// only active users in an eligible role (system_admin, professional_manager,
// shift_supervisor, technician) are offered -- viewer is excluded even when
// active, and a tombstoned/deleted profile is always inactive by
// construction (profiles_deleted_implies_inactive, migration 0012), so the
// `active` filter alone already excludes it. This is the ONE place that
// filters/groups/sorts owner candidates -- every caller (incident creation,
// full update, technician's own assign/reassign flow, incomplete-readiness
// closure's continuation owner, reopening) renders this shared component
// rather than reimplementing the rule.
import type { Profile } from '../domain/types';
import { ELIGIBLE_OWNER_ROLES } from '../domain/permissions';
import { roleLabels } from '../domain/labels';
import { Field, Select } from './ui';

/** Active, role-eligible profiles grouped by role (in ELIGIBLE_OWNER_ROLES
 *  order) and sorted alphabetically by fullName within each group, using a
 *  Hebrew-aware comparison -- matching the sort convention already used
 *  elsewhere in this codebase (e.g. localRepository.ts's own profile/
 *  reference-name sorts). A role with no eligible members is omitted
 *  entirely, never an empty group. */
function groupEligibleOwners(profiles: Profile[] | undefined): Array<{ role: Profile['role']; profiles: Profile[] }> {
  const byRole = new Map<Profile['role'], Profile[]>();
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

export function OwnerField({
  profiles,
  ownerUserId,
  onChange,
  error,
  hint,
  legacyExternalName,
}: {
  profiles: Profile[] | undefined;
  ownerUserId: string;
  onChange: (userId: string) => void;
  error?: string;
  /** Optional general guidance shown when there is no legacy carry-over
   *  fact to show instead (below). */
  hint?: string;
  /** Set when this incident's internal owner is still null and its legacy
   *  owner_external_name (external-only, pre-dating the additive external
   *  handling party model) is set -- shown as a read-only carry-over hint
   *  so the operator sees what a chosen internal owner is joining, never a
   *  silently dropped fact. Takes priority over `hint` when both apply. */
  legacyExternalName?: string | null;
}) {
  const groups = groupEligibleOwners(profiles);
  return (
    <Field
      label="בעל אחריות פנימי"
      required
      error={error}
      hint={
        legacyExternalName
          ? `גורם מטפל חיצוני קודם: ${legacyExternalName} — יש לבחור בעל אחריות פנימי`
          : hint
      }
    >
      {(a) => (
        <Select {...a} value={ownerUserId} onChange={(e) => onChange(e.target.value)}>
          <option value="">— בחר —</option>
          {groups.map((group) => (
            <optgroup key={group.role} label={roleLabels[group.role]}>
              {group.profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.fullName}</option>
              ))}
            </optgroup>
          ))}
        </Select>
      )}
    </Field>
  );
}
