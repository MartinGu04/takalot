// Update dialog: full operational update (protected fields) or restricted
// technician update, depending on the current user's role and capability.
import { useState } from 'react';
import type { Incident, ReportedToOps, SuspectedCause } from '../../domain/types';
import {
  severityLabels,
  statusLabels,
  reportedToOpsLabels,
  suspectedCauseLabels,
  SUSPECTED_CAUSE_ORDER,
  UNASSESSED_CAUSE_LABEL,
} from '../../domain/labels';
import {
  updateIncidentSchema,
  technicianUpdateSchema,
  type UpdateIncidentInput,
  type TechnicianUpdateInput,
  type TreatmentActionInput,
} from '../../domain/schemas';
import { canTransition, transitionError } from '../../domain/transitions';
import { useProfiles } from '../../data/hooks';
import { useAuth } from '../../auth/AuthContext';
import { hasCapability, canTechnicianUpdate } from '../../domain/permissions';
import { Dialog, Disclosure, Field, Input, Select, Textarea, Button, DateTimeLocalInput } from '../ui';
import { OwnerField } from '../OwnerField';
import { ExternalPartyFields } from '../ExternalPartyFields';
import { TreatmentActionPicker } from '../TreatmentActionPicker';
import { isoToLocalInput, localInputToIso } from '../../lib/time';

// Distinct sentinel from every real SuspectedCause enum member -- "not
// touched," never sent to the RPC (never reconfirmed on every update).
const CAUSE_UNCHANGED = '' as const;

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
  const [extName, setExtName] = useState(incident.externalHandlerName ?? '');
  const [extPerson, setExtPerson] = useState(incident.externalHandlerContactPerson ?? '');
  const [extDetails, setExtDetails] = useState(incident.externalHandlerContactDetails ?? '');
  // Update-specific reporting: three fresh questions about THIS update only
  // -- deliberately never seeded from the incident's own opening-time
  // reportedToOps/reportedToComms/wisdomReported facts, and always reset to
  // an unanswered '' placeholder on open/close/reset, never a default like
  // 'no'. See updateIncidentSchema (updateReportedToOps/updateReportedToComms/
  // updateWisdomReported) for why '' is a distinct, required-to-resolve state.
  const [updateReportedToOps, setUpdateReportedToOps] = useState<ReportedToOps | ''>('');
  const [updateReportedToOpsRecipient, setUpdateReportedToOpsRecipient] = useState('');
  const [updateReportedToComms, setUpdateReportedToComms] = useState<'yes' | 'no' | ''>('');
  const [updateReportedToCommsRecipient, setUpdateReportedToCommsRecipient] = useState('');
  const [updateWisdomReported, setUpdateWisdomReported] = useState<'yes' | 'no' | ''>('');
  const [changeReason, setChangeReason] = useState('');
  const [note, setNote] = useState('');
  const [ownerError, setOwnerError] = useState<string | undefined>();
  const [extError, setExtError] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  // Behind the "הוספת פרטי טיפול" disclosure -- both entirely optional,
  // available in full and technician mode alike. CAUSE_UNCHANGED means the
  // user never touched the cause control this session; only an actively
  // chosen value is ever sent.
  const [suspectedCause, setSuspectedCause] = useState<SuspectedCause | typeof CAUSE_UNCHANGED>(CAUSE_UNCHANGED);
  const [suspectedCauseOtherDetail, setSuspectedCauseOtherDetail] = useState('');
  const [treatmentActions, setTreatmentActions] = useState<TreatmentActionInput[]>([]);
  const [causeOtherError, setCauseOtherError] = useState<string | undefined>();
  const [classificationOpen, setClassificationOpen] = useState(false);

  const reset = () => {
    setEventTime(isoToLocalInput(new Date().toISOString()));
    setActionsTaken('');
    setFindings('');
    setNextSteps('');
    setCurrentStatusText('');
    setNote('');
    setStatus(incident.status);
    setSeverity(incident.severity);
    setOwnerUserId(incident.ownerUserId ?? '');
    setExtName(incident.externalHandlerName ?? '');
    setExtPerson(incident.externalHandlerContactPerson ?? '');
    setExtDetails(incident.externalHandlerContactDetails ?? '');
    setOwnerError(undefined);
    setExtError(undefined);
    setUpdateReportedToOps('');
    setUpdateReportedToOpsRecipient('');
    setUpdateReportedToComms('');
    setUpdateReportedToCommsRecipient('');
    setUpdateWisdomReported('');
    setChangeReason('');
    setError(undefined);
    setSuspectedCause(CAUSE_UNCHANGED);
    setSuspectedCauseOtherDetail('');
    setTreatmentActions([]);
    setCauseOtherError(undefined);
    setClassificationOpen(false);
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
      externalHandlerName: extName || null,
      externalHandlerContactPerson: extPerson || null,
      externalHandlerContactDetails: extDetails || null,
      updateReportedToOps,
      updateReportedToOpsRecipient: updateReportedToOps === 'yes' ? updateReportedToOpsRecipient : null,
      updateReportedToComms,
      updateReportedToCommsRecipient: updateReportedToComms === 'yes' ? updateReportedToCommsRecipient : null,
      updateWisdomReported,
      note,
      // Omitted entirely (not merely nullable) when the user never touched
      // the disclosure -- "leaving it untouched behaves exactly as it does
      // today," never a reconfirmation prompt.
      ...(suspectedCause !== CAUSE_UNCHANGED
        ? { suspectedCause, suspectedCauseOtherDetail: suspectedCauseOtherDetail || undefined }
        : {}),
      treatmentActions,
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
      note,
      ...(suspectedCause !== CAUSE_UNCHANGED
        ? { suspectedCause, suspectedCauseOtherDetail: suspectedCauseOtherDetail || undefined }
        : {}),
      treatmentActions,
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
    setOwnerError(undefined);
    setExtError(undefined);
    setCauseOtherError(undefined);
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
        const ownerIssue = parsed.error.issues.find((i) => i.path[0] === 'ownerUserId');
        const extIssue = parsed.error.issues.find((i) => i.path[0] === 'externalHandlerName');
        const causeIssue = parsed.error.issues.find(
          (i) => i.path[0] === 'suspectedCauseOtherDetail' || i.path[0] === 'treatmentActions',
        );
        const otherIssue = parsed.error.issues.find(
          (i) =>
            i.path[0] !== 'ownerUserId' &&
            i.path[0] !== 'externalHandlerName' &&
            i.path[0] !== 'suspectedCauseOtherDetail' &&
            i.path[0] !== 'treatmentActions',
        );
        setOwnerError(ownerIssue?.message);
        setExtError(extIssue?.message);
        if (causeIssue) {
          setCauseOtherError(causeIssue.message);
          setClassificationOpen(true);
        }
        setError(otherIssue?.message);
        return;
      }
      onSubmitFull(parsed.data);
    } else {
      const parsed = technicianUpdateSchema.safeParse(buildTechInput());
      if (!parsed.success) {
        const causeIssue = parsed.error.issues.find(
          (i) => i.path[0] === 'suspectedCauseOtherDetail' || i.path[0] === 'treatmentActions',
        );
        if (causeIssue) {
          setCauseOtherError(causeIssue.message);
          setClassificationOpen(true);
        }
        setError(parsed.error.issues.find((i) => i.path[0] !== 'suspectedCauseOtherDetail' && i.path[0] !== 'treatmentActions')?.message);
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
          {(a) => <DateTimeLocalInput {...a} value={eventTime} onChange={setEventTime} />}
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
        <Field label="הערה נוספת">
          {(a) => (
            <>
              <Textarea
                {...a}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={600}
                placeholder="כל מידע נוסף שכדאי לתעד לצד עדכון זה (לא חובה)."
              />
              <p className="text-left text-xs text-muted">{note.length}/600</p>
            </>
          )}
        </Field>

        <Disclosure label="הוספת פרטי טיפול" open={classificationOpen} onOpenChange={setClassificationOpen}>
          <Field
            label="חשד נוכחי"
            hint={`חשד נוכחי: ${incident.currentSuspectedCause ? suspectedCauseLabels[incident.currentSuspectedCause] : UNASSESSED_CAUSE_LABEL}. שינוי כאן ייצור רישום היסטורי חדש; השארה ללא שינוי אינה דורשת אישור מחדש.`}
          >
            {(a) => (
              <Select
                {...a}
                value={suspectedCause}
                onChange={(e) => setSuspectedCause(e.target.value as SuspectedCause | typeof CAUSE_UNCHANGED)}
              >
                <option value={CAUSE_UNCHANGED}>ללא שינוי</option>
                {SUSPECTED_CAUSE_ORDER.map((c) => (
                  <option key={c} value={c}>
                    {suspectedCauseLabels[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {suspectedCause === 'other' && (
            <Field label="פירוט החשד" required error={causeOtherError}>
              {(a) => (
                <Input
                  {...a}
                  value={suspectedCauseOtherDetail}
                  onChange={(e) => setSuspectedCauseOtherDetail(e.target.value)}
                  maxLength={500}
                />
              )}
            </Field>
          )}
          <TreatmentActionPicker
            label="פעולות טיפול שבוצעו בעדכון זה"
            actions={treatmentActions}
            onChange={setTreatmentActions}
          />
        </Disclosure>

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
            <div className="flex flex-col gap-3 border-t border-hairline pt-3">
              <p className="text-xs text-muted">
                דיווח בעדכון זה בלבד -- אינו נובע מפרטי הדיווח שנקבעו בעת פתיחת התקלה ואינו משנה אותם.
              </p>
              <Field label="דווח למבצעים?" required>
                {(a) => (
                  <Select
                    {...a}
                    value={updateReportedToOps}
                    onChange={(e) => {
                      const next = e.target.value as ReportedToOps | '';
                      setUpdateReportedToOps(next);
                      if (next !== 'yes') setUpdateReportedToOpsRecipient('');
                    }}
                  >
                    <option value="">— בחירה —</option>
                    {Object.entries(reportedToOpsLabels).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </Select>
                )}
              </Field>
              {updateReportedToOps === 'yes' && (
                <Field label="למי דווח? (מבצעים)" required>
                  {(a) => (
                    <Input
                      {...a}
                      value={updateReportedToOpsRecipient}
                      onChange={(e) => setUpdateReportedToOpsRecipient(e.target.value)}
                      placeholder="לדוגמה: אחמ״ש מוקד מבצעים / שם"
                      maxLength={200}
                    />
                  )}
                </Field>
              )}
              <Field label="האם דווח לתקשוב למבצעים?" required>
                {(a) => (
                  <Select
                    {...a}
                    value={updateReportedToComms}
                    onChange={(e) => {
                      const next = e.target.value as 'yes' | 'no' | '';
                      setUpdateReportedToComms(next);
                      if (next !== 'yes') setUpdateReportedToCommsRecipient('');
                    }}
                  >
                    <option value="">— בחירה —</option>
                    <option value="no">לא</option>
                    <option value="yes">כן</option>
                  </Select>
                )}
              </Field>
              {updateReportedToComms === 'yes' && (
                <Field label="למי דווח? (תקשוב למבצעים)" required>
                  {(a) => (
                    <Input
                      {...a}
                      value={updateReportedToCommsRecipient}
                      onChange={(e) => setUpdateReportedToCommsRecipient(e.target.value)}
                      placeholder="לדוגמה: תקשוב מוקד מבצעים / שם"
                      maxLength={200}
                    />
                  )}
                </Field>
              )}
              <Field label="האם עודכן ב-WISDOM?" required>
                {(a) => (
                  <Select
                    {...a}
                    value={updateWisdomReported}
                    onChange={(e) => setUpdateWisdomReported(e.target.value as 'yes' | 'no' | '')}
                  >
                    <option value="">— בחירה —</option>
                    <option value="no">לא</option>
                    <option value="yes">כן</option>
                  </Select>
                )}
              </Field>
            </div>
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
