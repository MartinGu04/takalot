// Internal owner picker: every actively managed incident requires a valid,
// active internal owner. External handling is a separate, additive concept
// -- see ExternalPartyFields -- never a substitute shown in this control.
import type { Profile } from '../domain/types';
import { Field, Select } from './ui';

export function OwnerField({
  profiles,
  ownerUserId,
  onChange,
  error,
  legacyExternalName,
}: {
  profiles: Profile[] | undefined;
  ownerUserId: string;
  onChange: (userId: string) => void;
  error?: string;
  /** Set when this incident's internal owner is still null and its legacy
   *  owner_external_name (external-only, pre-dating the additive external
   *  handling party model) is set -- shown as a read-only carry-over hint
   *  so the operator sees what a chosen internal owner is joining, never a
   *  silently dropped fact. */
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
          : undefined
      }
    >
      {(a) => (
        <Select {...a} value={ownerUserId} onChange={(e) => onChange(e.target.value)}>
          <option value="">— בחר —</option>
          {profiles?.filter((p) => p.active).map((p) => (
            <option key={p.id} value={p.id}>{p.fullName}</option>
          ))}
        </Select>
      )}
    </Field>
  );
}
