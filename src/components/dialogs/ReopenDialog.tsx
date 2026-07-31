import { useEffect, useRef, useState } from 'react';
import type { Incident } from '../../domain/types';
import { reopenIncidentSchema, type ReopenIncidentInput } from '../../domain/schemas';
import { useProfiles } from '../../data/hooks';
import { Dialog, Field, Textarea, Button } from '../ui';
import { OwnerField } from '../OwnerField';
import { ExternalPartyFields } from '../ExternalPartyFields';

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
  const [extName, setExtName] = useState(incident.externalHandlerName ?? '');
  const [extPerson, setExtPerson] = useState(incident.externalHandlerContactPerson ?? '');
  const [extDetails, setExtDetails] = useState(incident.externalHandlerContactDetails ?? '');
  const [ownerError, setOwnerError] = useState<string | undefined>();
  const [extError, setExtError] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  // This dialog stays mounted across opens/closes (unlike UpdateDialog,
  // which remounts fresh each time), so ownerUserId/external-handler
  // fields above would otherwise keep showing whatever `incident` looked
  // like at first mount, even after another flow changes them. Hydrating
  // only on the closed->open transition (not on every `incident` change)
  // avoids clobbering an in-progress edit while this dialog is already
  // open.
  const wasOpenRef = useRef(open);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setOwnerUserId(incident.ownerUserId ?? '');
      setExtName(incident.externalHandlerName ?? '');
      setExtPerson(incident.externalHandlerContactPerson ?? '');
      setExtDetails(incident.externalHandlerContactDetails ?? '');
      setOwnerError(undefined);
      setExtError(undefined);
    }
    wasOpenRef.current = open;
  }, [open, incident]);

  const handleClose = () => {
    setReason('');
    setError(undefined);
    onClose();
  };

  const submit = () => {
    const parsed = reopenIncidentSchema.safeParse({
      expectedVersion: incident.version,
      reason,
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
    <Dialog open={open} onClose={handleClose} title="פתיחה מחדש של תקלה">
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="סיבת הפתיחה מחדש" required>
          {(a) => <Textarea {...a} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />}
        </Field>
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
        {error && <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={handleClose}>ביטול</Button>
          <Button type="submit" disabled={submitting}>{submitting ? 'פותח…' : 'פתיחה מחדש'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
