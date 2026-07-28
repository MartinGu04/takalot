// Update dialog: full operational update (protected fields) or restricted
// technician update, depending on the current user's role and capability.
import { useState } from 'react';
import type { Incident } from '../../domain/types';
import { severityLabels, statusLabels, reportedToOpsLabels } from '../../domain/labels';
import {
  updateIncidentSchema,
  technicianUpdateSchema,
  type UpdateIncidentInput,
  type TechnicianUpdateInput,
} from '../../domain/schemas';
import { canTransition, transitionError } from '../../domain/transitions';
import { useProfiles } from '../../data/hooks';
import { useAuth } from '../../auth/AuthContext';
import { hasCapability, canTechnicianUpdate } from '../../domain/permissions';
import { Dialog, Field, Input, Select, Textarea, Button } from '../ui';
import { OwnerField } from '../OwnerField';
import { isoToLocalInput, localInputToIso } from '../../lib/time';

/** Statuses this dropdown must not offer as an update target.
 *  closed/reopened: reachable only through their own dedicated flows (long
 *  standing).
 *  cancelled: reachable only through its own dedicated flow, not yet
 *  exposed in any UI.
 *  waiting_equipment/waiting_information/waiting_validation: exist as enum
 *  values and are fully supported for reading/rendering/filtering, but the
 *  backend's is_valid_transition (migration 0017) does not yet allow
 *  transitioning into any of them from any status -- offering them here
 *  would present an option the backend always rejects. Temporary and
 *  pre-cutover: remove this exclusion once a backend PR extends
 *  is_valid_transition's target whitelist. */
const NOT_YET_SELECTABLE_UPDATE_TARGETS = new Set([
  'closed',
  'reopened',
  'cancelled',
  'waiting_equipment',
  'waiting_information',
  'waiting_validation',
]);

export function UpdateDialog({
  open,
  onClose,
  incident,
  onSubmitFull,
  onSubmitTechnician,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  incident: Incident;
  onSubmitFull: (input: UpdateIncidentInput) => void;
  onSubmitTechnician: (input: TechnicianUpdateInput) => void;
  submitting: boolean;
}) {
  const { user } = useAuth();
  const { data: profiles } = useProfiles();
  const isFull = user ? hasCapability(user.role, 'full_update') : false;
  const isTechnician = user ? canTechnicianUpdate(user.id, incident) : false;

  const [eventTime, setEventTime] = useState(() => isoToLocalInput(new Date().toISOString()));
  const [actionsTaken, setActionsTaken] = useState('');
  const [findings, setFindings] = useState('');
  const [nextSteps, setNextSteps] = useState('');
  const [status, setStatus] = useState(incident.status);
  const [severity, setSeverity] = useState(incident.severity);
  const [operationalImpact, setOperationalImpact] = useState(incident.operationalImpact);
  const [ownerUserId, setOwnerUserId] = useState(incident.ownerUserId ?? '');
  const [ownerExternalName, setOwnerExternalName] = useState(incident.ownerExternalName ?? '');
  const [hasDeadline, setHasDeadline] = useState(!!incident.nextUpdateDue);
  const [nextUpdateDue, setNextUpdateDue] = useState(
    incident.nextUpdateDue ? isoToLocalInput(incident.nextUpdateDue) : isoToLocalInput(new Date(Date.now() + 4 * 3600_000).toISOString()),
  );
  const [noDeadlineReason, setNoDeadlineReason] = useState(incident.noDeadlineReason ?? '');
  const [reportedToOps, setReportedToOps] = useState(incident.reportedToOps);
  const [reportedToOpsRecipient, setReportedToOpsRecipient] = useState(incident.reportedToOpsRecipient ?? '');
  const [changeReason, setChangeReason] = useState('');
  const [error, setError] = useState<string | undefined>();

  const reset = () => {
    setEventTime(isoToLocalInput(new Date().toISOString()));
    setActionsTaken('');
    setFindings('');
    setNextSteps('');
    setStatus(incident.status);
    setSeverity(incident.severity);
    setOperationalImpact(incident.operationalImpact);
    setOwnerUserId(incident.ownerUserId ?? '');
    setOwnerExternalName(incident.ownerExternalName ?? '');
    setHasDeadline(!!incident.nextUpdateDue);
    setNextUpdateDue(incident.nextUpdateDue ? isoToLocalInput(incident.nextUpdateDue) : isoToLocalInput(new Date(Date.now() + 4 * 3600_000).toISOString()));
    setNoDeadlineReason(incident.noDeadlineReason ?? '');
    setReportedToOps(incident.reportedToOps);
    setReportedToOpsRecipient(incident.reportedToOpsRecipient ?? '');
    setChangeReason('');
    setError(undefined);
  };

  function buildFullInput() {
    return {
      expectedVersion: incident.version,
      eventTime: localInputToIso(eventTime),
      actionsTaken,
      findings,
      nextSteps,
      status,
      severity,
      operationalImpact,
      changeReason,
      ownerUserId: ownerUserId || null,
      ownerExternalName: ownerExternalName || null,
      nextUpdateDue: hasDeadline ? localInputToIso(nextUpdateDue) : null,
      noDeadlineReason: hasDeadline ? null : noDeadlineReason,
      reportedToOps,
      reportedToOpsRecipient: reportedToOps === 'yes' ? reportedToOpsRecipient : null,
    };
  }
  function buildTechInput() {
    return {
      expectedVersion: incident.version,
      eventTime: localInputToIso(eventTime),
      actionsTaken,
      findings,
      nextSteps,
    };
  }

  const handleClose = () => {
    reset();
    onClose();
  };

  // Mirrors update_incident's/technician_update_incident's own bounds check
  // (migration 0020, same pattern already established by cancel_incident):
  // the actual event time must fall between the incident's discovery and
  // five minutes from now. Fast UX feedback only -- the database remains
  // the final boundary.
  function eventTimeBoundsError(iso: string): string | undefined {
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return 'מועד העדכון בפועל אינו תקין.';
    if (t < new Date(incident.discoveredAt)) return 'מועד העדכון בפועל אינו יכול להיות לפני שעת גילוי התקלה.';
    if (t.getTime() > Date.now() + 5 * 60_000) return 'מועד העדכון בפועל אינו יכול להיות בעתיד.';
    return undefined;
  }

  const submit = () => {
    setError(undefined);
    const boundsError = eventTimeBoundsError(localInputToIso(eventTime));
    if (boundsError) {
      setError(boundsError);
      return;
    }
    if (isFull) {
      if (!canTransition(incident.status, status)) {
        setError(transitionError(incident.status, status));
        return;
      }
      const parsed = updateIncidentSchema.safeParse(buildFullInput());
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message);
        return;
      }
      onSubmitFull(parsed.data);
    } else {
      const parsed = technicianUpdateSchema.safeParse(buildTechInput());
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message);
        return;
      }
      onSubmitTechnician(parsed.data);
    }
  };

  if (!isFull && !isTechnician) return null;

  return (
    <Dialog open={open} onClose={handleClose} title="עדכון תקלה" wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field
          label="מועד העדכון בפועל"
          required
          hint="המועד שבו העדכון או הפעולה התרחשו בפועל, גם אם התיעוד נעשה מאוחר יותר."
        >
          {(a) => <Input {...a} type="datetime-local" value={eventTime} onChange={(e) => setEventTime(e.target.value)} />}
        </Field>
        <Field label="פעולות שבוצעו מאז העדכון הקודם" required>
          {(a) => (
            <Textarea
              {...a}
              value={actionsTaken}
              onChange={(e) => setActionsTaken(e.target.value)}
              maxLength={4000}
              placeholder="אילו בדיקות, פעולות או ניסיונות פתרון בוצעו מאז העדכון הקודם?"
            />
          )}
        </Field>
        <Field label="ממצאים">
          {(a) => <Textarea {...a} value={findings} onChange={(e) => setFindings(e.target.value)} maxLength={4000} />}
        </Field>
        <Field label="פעולות המשך">
          {(a) => <Textarea {...a} value={nextSteps} onChange={(e) => setNextSteps(e.target.value)} maxLength={2000} />}
        </Field>

        {isFull && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="סטטוס נוכחי" required>
                {(a) => (
                  <Select {...a} value={status} onChange={(e) => setStatus(e.target.value as Incident['status'])}>
                    {Object.entries(statusLabels)
                      // The incident's OWN current status must always render
                      // as an option (so a historical/externally-inserted
                      // incident already in e.g. waiting_equipment still
                      // shows a correctly selected dropdown) -- only a
                      // DIFFERENT not-yet-selectable status is hidden as a
                      // choice.
                      .filter(([k]) => k === incident.status || !NOT_YET_SELECTABLE_UPDATE_TARGETS.has(k))
                      .map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                  </Select>
                )}
              </Field>
              <Field label="חומרה" required>
                {(a) => (
                  <Select {...a} value={severity} onChange={(e) => setSeverity(e.target.value as Incident['severity'])}>
                    {Object.entries(severityLabels).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <Field label="השפעה מבצעית" required>
              {(a) => (
                <Textarea
                  {...a}
                  rows={2}
                  value={operationalImpact}
                  onChange={(e) => setOperationalImpact(e.target.value)}
                  maxLength={1000}
                  placeholder="כיצד המצב הנוכחי משפיע על הפעילות, השירות או המשתמשים?"
                />
              )}
            </Field>
            <OwnerField
              profiles={profiles}
              ownerUserId={ownerUserId}
              ownerExternalName={ownerExternalName}
              onChangeInternal={setOwnerUserId}
              onChangeExternal={setOwnerExternalName}
            />
            <div className="rounded-xl border border-hairline p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={hasDeadline} onChange={(e) => setHasDeadline(e.target.checked)} />
                יש צפי לעדכון הבא
              </label>
              {hasDeadline ? (
                <div className="mt-2">
                  <Field label="צפי לעדכון הבא">
                    {(a) => <Input {...a} type="datetime-local" value={nextUpdateDue} onChange={(e) => setNextUpdateDue(e.target.value)} />}
                  </Field>
                </div>
              ) : (
                <div className="mt-2">
                  <Field label='נימוק ל"ללא צפי כרגע"' required>
                    {(a) => <Input {...a} value={noDeadlineReason} onChange={(e) => setNoDeadlineReason(e.target.value)} />}
                  </Field>
                </div>
              )}
            </div>
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
            {(status !== incident.status || severity !== incident.severity) && (
              <Field label="נימוק לשינוי (מומלץ)">
                {(a) => <Input {...a} value={changeReason} onChange={(e) => setChangeReason(e.target.value)} />}
              </Field>
            )}
          </>
        )}

        {error && <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={handleClose}>ביטול</Button>
          <Button type="submit" disabled={submitting}>{submitting ? 'שומר…' : 'שמירת עדכון'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
