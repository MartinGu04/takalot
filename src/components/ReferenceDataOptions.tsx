// Grouped <option> fragments for every system/location <Select> in the
// app -- incident creation, and the various filter bars. Mirrors the
// grouping mechanics OwnerField already established for the internal-owner
// picker (Map-by-key -> fixed-order array -> one <optgroup> per non-empty
// group), applied to the fixed system/location categories instead of
// roles. A category with no matching options renders nothing (an empty
// <optgroup> has no visible presence), so search/filtering naturally hides
// empty sections without any extra logic here.
//
// Deliberately just the <option>/<optgroup> markup, not a full Field+Select
// wrapper: every call site already owns its <Select> (react-hook-form
// `register`-bound in incident creation, or a controlled filter value
// elsewhere), and grouping the options changes none of that wiring --
// validation, keyboard navigation, and mobile behavior all keep working
// exactly as they did with a flat option list, because they are properties
// of the native <select> itself, not of how its options are grouped.
import { groupLocationsByCategory, groupSystemsByCategory } from '../domain/referenceDataCategories';
import { groupEligibleOwners } from '../domain/permissions';
import { locationCategoryLabels, systemCategoryLabels, personnelRoleLabels } from '../domain/labels';
import type { LocationRecord, Profile, SystemRecord } from '../domain/types';

export function SystemOptions({
  systems,
  includeArchived = false,
}: {
  systems: SystemRecord[] | undefined;
  /** Filter bars over historical incidents must still offer an archived
   *  system so a past incident referencing it stays findable -- the
   *  "(בארכיון)" suffix is the existing convention for marking those. */
  includeArchived?: boolean;
}) {
  const eligible = includeArchived ? (systems ?? []) : (systems ?? []).filter((s) => !s.archived);
  const groups = groupSystemsByCategory(eligible);
  return (
    <>
      {groups.map((group) =>
        group.records.length > 0 ? (
          <optgroup key={group.category} label={systemCategoryLabels[group.category]}>
            {group.records.map((system) => (
              <option key={system.id} value={system.id}>
                {system.name}
                {system.archived ? ' (בארכיון)' : ''}
              </option>
            ))}
          </optgroup>
        ) : null,
      )}
    </>
  );
}

/** Active, role-eligible internal owners grouped by role -- same grouping
 *  (groupEligibleOwners) and role-order/labels (personnelRoleLabels) as
 *  OwnerField's own internal-owner picker, reused here so an assignee
 *  filter never re-derives its own eligibility/grouping rule. A viewer, an
 *  inactive user, or a role with no eligible members simply never appears. */
export function EligibleOwnerOptions({ profiles }: { profiles: Profile[] | undefined }) {
  const groups = groupEligibleOwners(profiles);
  return (
    <>
      {groups.map((group) => (
        <optgroup key={group.role} label={personnelRoleLabels[group.role]}>
          {group.profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.fullName}</option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

export function LocationOptions({
  locations,
  includeArchived = false,
}: {
  locations: LocationRecord[] | undefined;
  includeArchived?: boolean;
}) {
  const eligible = includeArchived ? (locations ?? []) : (locations ?? []).filter((l) => !l.archived);
  const groups = groupLocationsByCategory(eligible);
  return (
    <>
      {groups.map((group) =>
        group.records.length > 0 ? (
          <optgroup key={group.category} label={locationCategoryLabels[group.category]}>
            {group.records.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
                {location.archived ? ' (בארכיון)' : ''}
              </option>
            ))}
          </optgroup>
        ) : null,
      )}
    </>
  );
}
