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

/** מצב הטיפול -- the simplified three-state treatment model this dialog
 *  offers for a full update. "בהמתנה" is a single UI category covering
 *  three structured, backend-real sub-reasons (below); it has no enum
 *  value of its own. */
type TreatmentCategory = 'in_progress' | 'waiting' | 'monitoring' | 'other';

const WAITING_REASONS: { value: Incident['status']; label: string }[] = [
  { value: 'waiting_external', label: 'גורם חיצוני' },
  { value: 'waiting_information', label: 'מידע או החלטה' },
  { value: 'waiting_validation', label: 'בדיקה או אימות' },
];
const WAITING_STATUSES = new Set(WAITING_REASONS.map((r) => r.value));

function treatmentCategory(status: Incident['status']): TreatmentCategory {
  if (status === 'in_progress') return 'in_progress';
  if (WAITING_STATUSES.has(status)) return 'waiting';
  if (status === 'monitoring') return 'monitoring';
  return 'other';
}

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
  const [currentStatusText, setCurrentStatusText] = useState('');
  const [status, setStatus] = useState(incident.status);
  const [severity, setSeverity] = useState(incident.severity);
  const [ownerUserId, setOwnerUserId] = useState(incident.ownerUserId ?? '');
  const [ownerExternalName, setOwnerExternalName] = useState(incident.ownerExternalName ?? '');
  const [reportedToOps, setReportedToOps] = useState(incident.reportedToOps);
  const [reportedToOpsRecipient, setReportedToOpsRecipient] = useState(incident.reportedToOpsRecipient ?? '');
  const [changeReason, setChangeReason] = useState('');
  const [error, setError] = useState<string | undefined>();

  const reset = () => {
    setEventTime(isoToLocalInput(new Date().toISOString()));
    setActionsTaken('');
    setFindings('');
    setNextSteps('');
    setCurrentStatusText('');
    setStatus(incident.status);
    setSeverity(incident.severity);
    setOwnerUserId(incident.ownerUserId ?? '');
    setOwnerExternalName(incident.ownerExternalName ?? '');
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
      currentStatusText,
      status,
      severity,
      changeReason,
      ownerUserId: ownerUserId || null,
      ownerExternalName: ownerExternalName || null,
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
      currentStatusText,
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

  const category = treatmentCategory(status);
  // Reachability is always computed from the incident's OWN starting status
  // (never from `status`, which may already have been changed by the user
  // this session) -- these three checks mirror canTransition/is_valid_transition
  // exactly, so the picker never offers a target the backend would reject.
  const canInProgress = canTransition(incident.status, 'in_progress');
  const canMonitoring = canTransition(incident.status, 'monitoring');
  const reachableWaitingReasons = WAITING_REASONS.filter((r) => canTransition(incident.status, r.value));
  const canWaiting = reachableWaitingReasons.length > 0;
  // A hidden/legacy/internal status (anything outside this simplified
  // three-category model, e.g. new/acknowledged/waiting_test/
  // partial_readiness/resolved_pending_close/waiting_equipment/reopened) is
  // never offered as a selector choice -- it's shown as separate read-only
  // context instead, and the underlying status is left exactly as-is unless
  // the user actively picks one of the reachable targets below.
  const isLegacyCurrentStatus = treatmentCategory(incident.status) === 'other';

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
        <Field label="סטטוס נוכחי" required hint="המצב המבצעי כרגע -- מה קורה עם התקלה ברגע זה.">
          {(a) => (
            <>
              <Textarea
                {...a}
                value={currentStatusText}
                onChange={(e) => setCurrentStatusText(e.target.value)}
                maxLength={1000}
                placeholder="לדוגמה: הצוות הטכני בדרך לאתר, ממתינים להערכת נזק."
              />
              <p className="text-left text-xs text-muted">{currentStatusText.length}/1000</p>
            </>
          )}
        </Field>

        {isFull && (
          <>
            {isLegacyCurrentStatus && (
              <p className="text-sm text-muted">
                סטטוס נוכחי: <strong>{statusLabels[incident.status]}</strong> (רישום קיים, אינו חלק ממודל מצב הטיפול המובנה)
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="מצב הטיפול" required>
                {(a) => (
                  <Select
                    {...a}
                    value={category === 'other' ? '' : category}
                    onChange={(e) => {
                      const next = e.target.value as TreatmentCategory | '';
                      if (next === 'waiting') {
                        setStatus(
                          reachableWaitingReasons.some((r) => r.value === status)
                            ? status
                            : reachableWaitingReasons[0].value,
                        );
                      } else if (next === 'in_progress' || next === 'monitoring') {
                        setStatus(next);
                      }
                    }}
                  >
                    {/* Only shown while the current status hasn't been
                        assigned to any of the three categories -- selecting
                        (or leaving) this placeholder submits the incident's
                        unchanged current status (a no-op update), never a
                        coerced default. */}
                    {category === 'other' && <option value="">— לבחירת מצב טיפול חדש —</option>}
                    {canInProgress && <option value="in_progress">בטיפול</option>}
                    {canWaiting && <option value="waiting">בהמתנה</option>}
                    {canMonitoring && <option value="monitoring">במעקב</option>}
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
            {category === 'waiting' && (
              <Field label="סיבת ההמתנה" required>
                {(a) => (
                  <Select {...a} value={status} onChange={(e) => setStatus(e.target.value as Incident['status'])}>
                    {reachableWaitingReasons.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <OwnerField
              profiles={profiles}
              ownerUserId={ownerUserId}
              ownerExternalName={ownerExternalName}
              onChangeInternal={setOwnerUserId}
              onChangeExternal={setOwnerExternalName}
            />
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
