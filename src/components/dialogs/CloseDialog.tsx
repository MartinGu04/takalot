import { useState } from 'react';
import type { Incident } from '../../domain/types';
import { closeIncidentSchema, type CloseIncidentInput } from '../../domain/schemas';
import { readinessLabels, reportedToOpsLabels } from '../../domain/labels';
import { formatDuration } from '../../lib/time';
import { Dialog, Field, Select, Textarea, Button } from '../ui';

export function CloseDialog({
  open,
  onClose,
  incident,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  incident: Incident;
  onSubmit: (input: CloseIncidentInput) => void;
  submitting: boolean;
}) {
  const [rootCause, setRootCause] = useState('');
  const [resolution, setResolution] = useState('');
  const [readiness, setReadiness] = useState<Incident['readinessAtClose']>('full');
  const [followUpNotes, setFollowUpNotes] = useState('');
  const [reportedToOps, setReportedToOps] = useState(incident.reportedToOps);
  const [error, setError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);

  const handleClose = () => {
    setRootCause('');
    setResolution('');
    setReadiness('full');
    setFollowUpNotes('');
    setConfirming(false);
    setError(undefined);
    onClose();
  };

  const parsedInput = () =>
    closeIncidentSchema.safeParse({
      expectedVersion: incident.version,
      rootCause,
      resolution,
      readiness: readiness ?? 'full',
      followUpNotes,
      reportedToOps,
    });

  const proceedToConfirm = () => {
    const parsed = parsedInput();
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    setError(undefined);
    setConfirming(true);
  };

  const confirm = () => {
    const parsed = parsedInput();
    if (parsed.success) onSubmit(parsed.data);
  };

  const estimatedDuration = formatDuration(incident.discoveredAt, new Date().toISOString());

  return (
    <Dialog open={open} onClose={handleClose} title="סגירת תקלה" wide>
      {!confirming ? (
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); proceedToConfirm(); }}>
          <Field label="סיבת התקלה" required>
            {(a) => <Textarea {...a} rows={2} value={rootCause} onChange={(e) => setRootCause(e.target.value)} maxLength={2000} />}
          </Field>
          <Field label="הפתרון שבוצע" required>
            {(a) => <Textarea {...a} rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} maxLength={4000} />}
          </Field>
          <Field label="כשירות המערכת" required>
            {(a) => (
              <Select {...a} value={readiness ?? 'full'} onChange={(e) => setReadiness(e.target.value as Incident['readinessAtClose'])}>
                {Object.entries(readinessLabels).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            )}
          </Field>
          {readiness !== 'full' && (
            <Field label="פעולות המשך" required hint="חובה לפרט כאשר הכשירות אינה מלאה">
              {(a) => <Textarea {...a} value={followUpNotes} onChange={(e) => setFollowUpNotes(e.target.value)} maxLength={2000} />}
            </Field>
          )}
          <Field label="דווח למבצעים">
            {(a) => (
              <Select {...a} value={reportedToOps} onChange={(e) => setReportedToOps(e.target.value as Incident['reportedToOps'])}>
                {Object.entries(reportedToOpsLabels).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            )}
          </Field>
          <p className="text-sm text-muted">משך תקלה משוער עד כה: {estimatedDuration}</p>
          {error && <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={handleClose}>ביטול</Button>
            <Button type="submit">המשך לאישור סגירה</Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm">אנא אשרו את פרטי הסגירה:</p>
          <div className="rounded-lg bg-neutral-50 p-3 text-sm dark:bg-neutral-800">
            <p><strong>משך התקלה:</strong> {estimatedDuration}</p>
            <p className="mt-1"><strong>כשירות:</strong> {readinessLabels[readiness ?? 'full']}</p>
            {readiness !== 'full' && <p className="mt-1 text-orange-700 dark:text-orange-400">התקלה תסומן כ"כשירות לא מלאה" עד השלמת פעולות ההמשך.</p>}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>חזרה לעריכה</Button>
            <Button type="button" variant="danger" disabled={submitting} onClick={confirm}>
              {submitting ? 'סוגר…' : 'אישור סגירת תקלה'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
