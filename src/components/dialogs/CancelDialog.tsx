import { useState } from 'react';
import type { Incident } from '../../domain/types';
import { cancelIncidentSchema, type CancelIncidentInput } from '../../domain/schemas';
import { Dialog, Field, Input, Textarea, Button } from '../ui';
import { isoToLocalInput, localInputToIso } from '../../lib/time';

export function CancelDialog({
  open,
  onClose,
  incident,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  incident: Incident;
  onSubmit: (input: CancelIncidentInput) => void;
  submitting: boolean;
}) {
  const [reason, setReason] = useState('');
  const [eventTime, setEventTime] = useState(() => isoToLocalInput(new Date().toISOString()));
  const [error, setError] = useState<string | undefined>();

  const handleClose = () => {
    setReason('');
    setEventTime(isoToLocalInput(new Date().toISOString()));
    setError(undefined);
    onClose();
  };

  // Deliberately NOT a <form onSubmit>: the destructive confirm button is a
  // plain button click, not an Enter-key submit from within the date/time
  // field -- an irreversible action should never fire from an accidental
  // Enter keystroke.
  const submit = () => {
    const iso = localInputToIso(eventTime);
    const parsed = cancelIncidentSchema.safeParse({
      expectedVersion: incident.version,
      eventTime: iso,
      cancellationReason: reason,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    // Mirrors cancel_incident's own bounds check (migration 0017): the
    // cancellation event time must fall between the incident's discovery
    // and five minutes from now.
    if (new Date(iso) < new Date(incident.discoveredAt)) {
      setError('מועד הביטול אינו יכול להיות לפני שעת גילוי התקלה.');
      return;
    }
    if (new Date(iso).getTime() > Date.now() + 5 * 60_000) {
      setError('מועד הביטול אינו יכול להיות בעתיד.');
      return;
    }
    setError(undefined);
    onSubmit(parsed.data);
  };

  return (
    <Dialog open={open} onClose={handleClose} title="ביטול תקלה">
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          <span className="text-muted">תקלה: </span>
          <span className="font-semibold">{incident.number}</span>
        </p>
        <p className="text-sm text-muted">
          ביטול מיועד לתקלות שנפתחו בטעות או שאינן נחשבות לתקלה תקפה. הפעולה סופית ומסמנת את התקלה כמבוטלת.
        </p>
        <Field label="סיבת הביטול" required>
          {(a) => (
            <Textarea
              {...a}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={2000}
              placeholder="לדוגמה: התקלה נפתחה בטעות / כפילות / אינה תקלה בפועל"
            />
          )}
        </Field>
        <Field label="מועד הביטול בפועל" required>
          {(a) => (
            <Input {...a} type="datetime-local" value={eventTime} onChange={(e) => setEventTime(e.target.value)} />
          )}
        </Field>
        {error && <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={handleClose}>חזרה</Button>
          <Button type="button" variant="danger" disabled={submitting} onClick={submit}>
            {submitting ? 'מבטל…' : 'בטל תקלה'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
