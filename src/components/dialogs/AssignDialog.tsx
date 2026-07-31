import { useState } from 'react';
import type { Incident } from '../../domain/types';
import { assignIncidentSchema, type AssignIncidentInput } from '../../domain/schemas';
import { useProfiles } from '../../data/hooks';
import { Dialog, Field, Input, Button } from '../ui';
import { OwnerField } from '../OwnerField';
import { ExternalPartyFields } from '../ExternalPartyFields';

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
  const [extName, setExtName] = useState(incident.externalHandlerName ?? '');
  const [extPerson, setExtPerson] = useState(incident.externalHandlerContactPerson ?? '');
  const [extDetails, setExtDetails] = useState(incident.externalHandlerContactDetails ?? '');
  const [note, setNote] = useState('');
  const [ownerError, setOwnerError] = useState<string | undefined>();
  const [extError, setExtError] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const handleClose = () => {
    setOwnerUserId(incident.ownerUserId ?? '');
    setExtName(incident.externalHandlerName ?? '');
    setExtPerson(incident.externalHandlerContactPerson ?? '');
    setExtDetails(incident.externalHandlerContactDetails ?? '');
    setNote('');
    setOwnerError(undefined);
    setExtError(undefined);
    setError(undefined);
    onClose();
  };

  const submit = () => {
    const parsed = assignIncidentSchema.safeParse({
      expectedVersion: incident.version,
      note,
      ownerUserId: ownerUserId || null,
      externalHandlerName: extName || null,
      externalHandlerContactPerson: extPerson || null,
      externalHandlerContactDetails: extDetails || null,
    });
    if (!parsed.success) {
      const ownerIssue = parsed.error.issues.find((i) => i.path[0] === 'ownerUserId');
      const extIssue = parsed.error.issues.find((i) => i.path[0] === 'externalHandlerName');
      const otherIssue = parsed.error.issues.find((i) => i.path[0] !== 'ownerUserId' && i.path[0] !== 'externalHandlerName');
      setOwnerError(ownerIssue?.message);
      setExtError(extIssue?.message);
      setError(otherIssue?.message);
      return;
    }
    setOwnerError(undefined);
    setExtError(undefined);
    setError(undefined);
    onSubmit(parsed.data);
  };

  return (
    <Dialog open={open} onClose={handleClose} title="שינוי גורם מטפל">
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <OwnerField
          profiles={profiles}
          ownerUserId={ownerUserId}
          onChange={setOwnerUserId}
          error={ownerError}
          legacyExternalName={!incident.ownerUserId ? incident.ownerExternalName : null}
        />
        <ExternalPartyFields
          name={extName}
          contactPerson={extPerson}
          contactDetails={extDetails}
          onChangeName={setExtName}
          onChangeContactPerson={setExtPerson}
          onChangeContactDetails={setExtDetails}
          nameError={extError}
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
