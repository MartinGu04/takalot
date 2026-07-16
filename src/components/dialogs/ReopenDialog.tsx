import { useState } from 'react';
import type { Incident } from '../../domain/types';
import { reopenIncidentSchema, type ReopenIncidentInput } from '../../domain/schemas';
import { useProfiles } from '../../data/hooks';
import { Dialog, Field, Input, Textarea, Button } from '../ui';
import { OwnerField } from '../OwnerField';
import { isoToLocalInput, localInputToIso } from '../../lib/time';

export function ReopenDialog({
  open,
  onClose,
  incident,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  incident: Incident;
  onSubmit: (input: ReopenIncidentInput) => void;
  submitting: boolean;
}) {
  const { data: profiles } = useProfiles();
  const [reason, setReason] = useState('');
  const [ownerUserId, setOwnerUserId] = useState(incident.ownerUserId ?? '');
  const [ownerExternalName, setOwnerExternalName] = useState(incident.ownerExternalName ?? '');
  const [nextUpdateDue, setNextUpdateDue] = useState(isoToLocalInput(new Date(Date.now() + 3600_000).toISOString()));
  const [error, setError] = useState<string | undefined>();

  const handleClose = () => {
    setReason('');
    setError(undefined);
    onClose();
  };

  const submit = () => {
    const parsed = reopenIncidentSchema.safeParse({
      expectedVersion: incident.version,
      reason,
      nextUpdateDue: localInputToIso(nextUpdateDue),
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
    <Dialog open={open} onClose={handleClose} title="פתיחה מחדש של תקלה">
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="סיבת הפתיחה מחדש" required>
          {(a) => <Textarea {...a} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />}
        </Field>
        <OwnerField
          profiles={profiles}
          ownerUserId={ownerUserId}
          ownerExternalName={ownerExternalName}
          onChangeInternal={setOwnerUserId}
          onChangeExternal={setOwnerExternalName}
        />
        <Field label="צפי לעדכון הבא" required>
          {(a) => <Input {...a} type="datetime-local" value={nextUpdateDue} onChange={(e) => setNextUpdateDue(e.target.value)} />}
        </Field>
        {error && <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={handleClose}>ביטול</Button>
          <Button type="submit" disabled={submitting}>{submitting ? 'פותח…' : 'פתיחה מחדש'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
