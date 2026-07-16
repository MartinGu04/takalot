// Shared owner picker: active internal user OR named external handler.
import type { Profile } from '../domain/types';
import { Field, Input, Select } from './ui';

export function OwnerField({
  profiles,
  ownerUserId,
  ownerExternalName,
  onChangeInternal,
  onChangeExternal,
  error,
}: {
  profiles: Profile[] | undefined;
  ownerUserId: string;
  ownerExternalName: string;
  onChangeInternal: (userId: string) => void;
  onChangeExternal: (name: string) => void;
  error?: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="גורם מטפל פנימי" error={ownerUserId ? undefined : error}>
        {(a) => (
          <Select
            {...a}
            value={ownerUserId}
            onChange={(e) => {
              onChangeInternal(e.target.value);
              if (e.target.value) onChangeExternal('');
            }}
          >
            <option value="">— ללא —</option>
            {profiles?.filter((p) => p.active).map((p) => (
              <option key={p.id} value={p.id}>{p.fullName}</option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="או שם גורם חיצוני" error={!ownerUserId ? error : undefined} hint="למקרה שהמטפל אינו משתמש במערכת">
        {(a) => (
          <Input
            {...a}
            value={ownerExternalName}
            disabled={!!ownerUserId}
            onChange={(e) => onChangeExternal(e.target.value)}
            placeholder="לדוגמה: טכנאי מטעם ספק"
          />
        )}
      </Field>
    </div>
  );
}
