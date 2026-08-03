// Internal owner picker: every actively managed incident requires a valid,
// active internal owner. External handling is a separate, additive concept
// -- see ExternalPartyFields -- never a substitute shown in this control.
//
// Eligibility mirrors assert_owner_valid's role check (migration 0039):
// only active users in an eligible role (system_admin, professional_manager,
// shift_supervisor, technician) are offered -- viewer is excluded even when
// active, and a tombstoned/deleted profile is always inactive by
// construction (profiles_deleted_implies_inactive, migration 0012), so the
// `active` filter alone already excludes it. The actual filter/group/sort
// rule lives once in domain/permissions.ts's groupEligibleOwners (rendered
// here via EligibleOwnerOptions) -- every caller (incident creation, full
// update, technician's own assign/reassign flow, incomplete-readiness
// closure's continuation owner, reopening, and the incidents/archive
// assignee filters) shares that one rule rather than reimplementing it.
import type { Profile } from '../domain/types';
import { Field, Select } from './ui';
import { EligibleOwnerOptions } from './ReferenceDataOptions';

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
          <EligibleOwnerOptions profiles={profiles} />
        </Select>
      )}
    </Field>
  );
}
