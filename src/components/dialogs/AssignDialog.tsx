import { useState } from 'react';
import type { Incident } from '../../domain/types';
import { assignIncidentSchema, type AssignIncidentInput } from '../../domain/schemas';
import { useProfiles } from '../../data/hooks';
import { Dialog, Field, Input, Button } from '../ui';
import { OwnerField } from '../OwnerField';

export function AssignDialog({
  open,
  onClose,
  incident,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  incident: Incident;
  onSubmit: (input: AssignIncidentInput) => void;
  submitting: boolean;
}) {
  const { data: profiles } = useProfiles();
  const [ownerUserId, setOwnerUserId] = useState(incident.ownerUserId ?? '');
  const [ownerExternalName, setOwnerExternalName] = useState(incident.ownerExternalName ?? '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();

  const handleClose = () => {
    setOwnerUserId(incident.ownerUserId ?? '');
    setOwnerExternalName(incident.ownerExternalName ?? '');
    setNote('');
    setError(undefined);
    onClose();
  };

  const submit = () => {
    const parsed = assignIncidentSchema.safeParse({
      expectedVersion: incident.version,
      note,
      ownerUserId: ownerUserId || null,
      ownerExternalName: ownerExternalName || null,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    onSubmit(parsed.data);
  };

  return (
    <Dialog open={open} onClose={handleClose} title="שינוי גורם מטפל">
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <OwnerField
          profiles={profiles}
          ownerUserId={ownerUserId}
          ownerExternalName={ownerExternalName}
          onChangeInternal={setOwnerUserId}
          onChangeExternal={setOwnerExternalName}
        />
        <Field label="הערה (לא חובה)">
          {(a) => <Input {...a} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        {error && <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={handleClose}>ביטול</Button>
          <Button type="submit" disabled={submitting}>{submitting ? 'שומר…' : 'עדכון גורם מטפל'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
