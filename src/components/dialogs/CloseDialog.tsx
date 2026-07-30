import { useState } from 'react';
import type { Incident } from '../../domain/types';
import { closeIncidentSchema, type CloseIncidentInput } from '../../domain/schemas';
import { readinessLabels, reportedToOpsLabels } from '../../domain/labels';
import { formatDuration } from '../../lib/time';
import { Dialog, Field, Input, Select, Textarea, Button } from '../ui';
import { OwnerField } from '../OwnerField';
import { useProfiles } from '../../data/hooks';

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
  const { data: profiles } = useProfiles();
  const [rootCause, setRootCause] = useState('');
  const [resolution, setResolution] = useState('');
  const [readiness, setReadiness] = useState<Incident['readinessAtClose']>('full');
  const [followUpNotes, setFollowUpNotes] = useState('');
  const [ownerUserId, setOwnerUserId] = useState(incident.ownerUserId ?? '');
  const [ownerExternalName, setOwnerExternalName] = useState(incident.ownerExternalName ?? '');
  const [ownerError, setOwnerError] = useState<string | undefined>();
  const [reportedToOps, setReportedToOps] = useState(incident.reportedToOps);
  const [reportedToOpsRecipient, setReportedToOpsRecipient] = useState(incident.reportedToOpsRecipient ?? '');
  const [error, setError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);

  const fullyReady = readiness === 'full';

  const handleClose = () => {
    setRootCause('');
    setResolution('');
    setReadiness('full');
    setFollowUpNotes('');
    setOwnerUserId(incident.ownerUserId ?? '');
    setOwnerExternalName(incident.ownerExternalName ?? '');
    setOwnerError(undefined);
    // Both halves of the reporting answer are restored together: resetting
    // only the recipient could leave a "כן" selection paired with a cleared
    // recipient, a combination the user never chose.
    setReportedToOps(incident.reportedToOps);
    setReportedToOpsRecipient(incident.reportedToOpsRecipient ?? '');
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
      ownerUserId: fullyReady ? null : ownerUserId || null,
      ownerExternalName: fullyReady ? null : ownerExternalName || null,
      reportedToOps,
      reportedToOpsRecipient: reportedToOps === 'yes' ? reportedToOpsRecipient : null,
    });

  const proceedToConfirm = () => {
    const parsed = parsedInput();
    if (!parsed.success) {
      const ownerIssue = parsed.error.issues.find((i) => i.path[0] === 'ownerUserId');
      const otherIssue = parsed.error.issues.find((i) => i.path[0] !== 'ownerUserId');
      setOwnerError(ownerIssue?.message);
      setError(otherIssue?.message);
      return;
    }
    setOwnerError(undefined);
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
          {!fullyReady && (
            <>
              <Field label="פעולות המשך" required hint="חובה לפרט כאשר הכשירות אינה מלאה">
                {(a) => <Textarea {...a} value={followUpNotes} onChange={(e) => setFollowUpNotes(e.target.value)} maxLength={2000} />}
              </Field>
              <div className="rounded-xl border border-orange-200 bg-orange-50 p-3 dark:border-orange-900 dark:bg-orange-950/40">
                <p className="mb-2 text-sm text-orange-900 dark:text-orange-200">
                  התקלה תישאר פעילה עד להשלמת פעולות ההמשך — יש לקבוע גורם מטפל אחראי.
                </p>
                <OwnerField
                  profiles={profiles}
                  ownerUserId={ownerUserId}
                  ownerExternalName={ownerExternalName}
                  onChangeInternal={setOwnerUserId}
                  onChangeExternal={setOwnerExternalName}
                  error={ownerError}
                />
              </div>
            </>
          )}
          <Field label="דווח למבצעים">
            {(a) => (
              <Select
                {...a}
                value={reportedToOps}
                onChange={(e) => {
                  const next = e.target.value as Incident['reportedToOps'];
                  setReportedToOps(next);
                  if (next !== 'yes') setReportedToOpsRecipient('');
                }}
              >
                {Object.entries(reportedToOpsLabels).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            )}
          </Field>
          {reportedToOps === 'yes' && (
            <Field label="למי דווח?" required>
              {(a) => (
                <Input
                  {...a}
                  value={reportedToOpsRecipient}
                  onChange={(e) => setReportedToOpsRecipient(e.target.value)}
                  placeholder="לדוגמה: אחמ״ש מוקד מבצעים / שם"
                  maxLength={200}
                />
              )}
            </Field>
          )}
          <p className="text-sm text-muted">משך תקלה משוער עד כה: {estimatedDuration}</p>
          {error && <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={handleClose}>ביטול</Button>
            <Button type="submit">המשך לאישור סגירה</Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm">{fullyReady ? 'אנא אשרו את פרטי הסגירה:' : 'אנא אשרו את הפרטים — התקלה תישאר פעילה:'}</p>
          <div className="rounded-lg bg-surface-active p-3 text-sm">
            <p><strong>משך התקלה:</strong> {estimatedDuration}</p>
            <p className="mt-1"><strong>כשירות:</strong> {readinessLabels[readiness ?? 'full']}</p>
            {!fullyReady && (
              <p className="mt-1 text-orange-700 dark:text-orange-400">
                התקלה לא תיסגר — היא תסומן כ"כשירות חלקית" ותישאר בתקלות הפעילות עד השלמת פעולות ההמשך.
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>חזרה לעריכה</Button>
            <Button type="button" variant="danger" disabled={submitting} onClick={confirm}>
              {submitting ? 'שומר…' : fullyReady ? 'אישור סגירת תקלה' : 'אישור ושמירה'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
