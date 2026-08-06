import { useEffect, useRef, useState } from 'react';
import type { ConfirmedCause, Incident, ResolutionAttribution, SuspectedCause, TreatmentOutcome } from '../../domain/types';
import { closeIncidentSchema, type CloseIncidentInput, type TreatmentActionInput } from '../../domain/schemas';
import {
  readinessLabels,
  reportedToOpsLabels,
  confirmedCauseLabels,
  CONFIRMED_CAUSE_ORDER,
  treatmentOutcomeLabels,
  TREATMENT_OUTCOME_ORDER,
  resolutionAttributionLabels,
  RESOLUTION_ATTRIBUTION_ORDER,
  treatmentActionTypeLabels,
} from '../../domain/labels';
import { formatDuration, isoToLocalInput, localInputToIso } from '../../lib/time';
import { Dialog, Field, Input, Select, Textarea, Button, DateTimeLocalInput } from '../ui';
import { OwnerField } from '../OwnerField';
import { ExternalPartyFields } from '../ExternalPartyFields';
import { TreatmentActionPicker } from '../TreatmentActionPicker';
import { useProfiles, useIncidentTreatmentActions } from '../../data/hooks';

/** Maps a current suspected cause to its confirmed-cause counterpart for
 *  the (non-binding) closure suggestion chip: the two enums share every
 *  literal value except suspectedCause's 'unknown'/confirmedCause's
 *  'undetermined' (the same concept, different name) and 'other' (never
 *  suggested -- too ambiguous to pre-fill, it needs its own detail
 *  regardless). Returns null when there is nothing to suggest. */
function suggestConfirmedCause(cause: SuspectedCause | null): ConfirmedCause | null {
  if (!cause || cause === 'other') return null;
  if (cause === 'unknown') return 'undetermined';
  return cause;
}

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
  const { data: allTreatmentActions } = useIncidentTreatmentActions(incident.id);
  // Only actions recorded during the CURRENT (still-open) cycle are
  // selectable here -- an action from a previous, already-closed cycle
  // belongs to that cycle's own history, not this one.
  const cycleActions = (allTreatmentActions ?? []).filter((a) => a.cycleNumber === incident.reopenCount);
  const [eventTime, setEventTime] = useState(() => isoToLocalInput(new Date().toISOString()));
  const [rootCause, setRootCause] = useState('');
  const [resolution, setResolution] = useState('');
  const [readiness, setReadiness] = useState<Incident['readinessAtClose']>('full');
  const [followUpNotes, setFollowUpNotes] = useState('');
  const [ownerUserId, setOwnerUserId] = useState(incident.ownerUserId ?? '');
  const [extName, setExtName] = useState(incident.externalHandlerName ?? '');
  const [extPerson, setExtPerson] = useState(incident.externalHandlerContactPerson ?? '');
  const [extDetails, setExtDetails] = useState(incident.externalHandlerContactDetails ?? '');
  const [ownerError, setOwnerError] = useState<string | undefined>();
  const [extError, setExtError] = useState<string | undefined>();
  const [reportedToOps, setReportedToOps] = useState(incident.reportedToOps);
  const [reportedToOpsRecipient, setReportedToOpsRecipient] = useState(incident.reportedToOpsRecipient ?? '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);

  // Structured closure classification -- shown only when readiness is
  // full (only a genuine close carries a classification at all).
  const [confirmedCause, setConfirmedCause] = useState<ConfirmedCause | ''>('');
  const [confirmedCauseOtherDetail, setConfirmedCauseOtherDetail] = useState('');
  const [treatmentOutcome, setTreatmentOutcome] = useState<TreatmentOutcome | ''>('');
  const [treatmentOutcomeOtherDetail, setTreatmentOutcomeOtherDetail] = useState('');
  const [resolutionAttribution, setResolutionAttribution] = useState<ResolutionAttribution | ''>('');
  const [resolutionAttributionOtherDetail, setResolutionAttributionOtherDetail] = useState('');
  const [resolutionActionIds, setResolutionActionIds] = useState<string[]>([]);
  const [newTreatmentActions, setNewTreatmentActions] = useState<TreatmentActionInput[]>([]);
  const [confirmedCauseError, setConfirmedCauseError] = useState<string | undefined>();
  const [treatmentOutcomeError, setTreatmentOutcomeError] = useState<string | undefined>();
  const [resolutionAttributionError, setResolutionAttributionError] = useState<string | undefined>();

  const fullyReady = readiness === 'full';
  // 'התקלה נעלמה ללא פעולה' forces 'לא בוצעה פעולה' as a fixed consequence
  // -- never an editable control while this outcome is selected, since the
  // DB rejects any other combination outright (see migration 0046's
  // incident_closure_resolved_without_action_requires_no_action CHECK).
  const outcomeForcesNoAction = treatmentOutcome === 'resolved_without_action';
  const effectiveResolutionAttribution: ResolutionAttribution | '' = outcomeForcesNoAction
    ? 'no_action_taken'
    : resolutionAttribution;
  const suggestedConfirmedCause = suggestConfirmedCause(incident.currentSuspectedCause);

  // This dialog stays mounted across opens/closes (unlike UpdateDialog,
  // which remounts fresh each time), so ownerUserId/external-handler
  // fields above would otherwise keep showing whatever `incident` looked
  // like at first mount, even after another flow changes them. Hydrating
  // only on the closed->open transition (not on every `incident` change)
  // avoids clobbering an in-progress edit while this dialog is already
  // open. Scoped to the owner/external-handler fields only -- the rest of
  // this form's own reset-on-close behavior is unrelated and unchanged.
  const wasOpenRef = useRef(open);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setOwnerUserId(incident.ownerUserId ?? '');
      setExtName(incident.externalHandlerName ?? '');
      setExtPerson(incident.externalHandlerContactPerson ?? '');
      setExtDetails(incident.externalHandlerContactDetails ?? '');
      setOwnerError(undefined);
      setExtError(undefined);
      // The actual closure time defaults to "now" every time this dialog is
      // opened, not just at its first mount -- otherwise reopening it later
      // would keep showing whatever moment it happened to first render at.
      setEventTime(isoToLocalInput(new Date().toISOString()));
    }
    wasOpenRef.current = open;
  }, [open, incident]);

  const handleClose = () => {
    setEventTime(isoToLocalInput(new Date().toISOString()));
    setRootCause('');
    setResolution('');
    setReadiness('full');
    setFollowUpNotes('');
    setOwnerUserId(incident.ownerUserId ?? '');
    setExtName(incident.externalHandlerName ?? '');
    setExtPerson(incident.externalHandlerContactPerson ?? '');
    setExtDetails(incident.externalHandlerContactDetails ?? '');
    setOwnerError(undefined);
    setExtError(undefined);
    // Both halves of the reporting answer are restored together: resetting
    // only the recipient could leave a "כן" selection paired with a cleared
    // recipient, a combination the user never chose.
    setReportedToOps(incident.reportedToOps);
    setReportedToOpsRecipient(incident.reportedToOpsRecipient ?? '');
    setNote('');
    setConfirming(false);
    setError(undefined);
    setConfirmedCause('');
    setConfirmedCauseOtherDetail('');
    setTreatmentOutcome('');
    setTreatmentOutcomeOtherDetail('');
    setResolutionAttribution('');
    setResolutionAttributionOtherDetail('');
    setResolutionActionIds([]);
    setNewTreatmentActions([]);
    setConfirmedCauseError(undefined);
    setTreatmentOutcomeError(undefined);
    setResolutionAttributionError(undefined);
    onClose();
  };

  // Mirrors close_incident's own bounds check (migration 0033, same guarded-
  // cast pattern already established by update_incident): the actual
  // closure time must fall between the incident's discovery and five
  // minutes from now. Fast UX feedback only -- the database remains the
  // final boundary.
  function eventTimeBoundsError(iso: string): string | undefined {
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return 'מועד סגירת התקלה אינו תקין.';
    if (t < new Date(incident.discoveredAt)) return 'מועד סגירת התקלה אינו יכול להיות לפני שעת גילוי התקלה.';
    if (t.getTime() > Date.now() + 5 * 60_000) return 'מועד סגירת התקלה אינו יכול להיות בעתיד.';
    return undefined;
  }

  const parsedInput = () =>
    closeIncidentSchema.safeParse({
      expectedVersion: incident.version,
      eventTime: localInputToIso(eventTime),
      rootCause,
      resolution,
      readiness: readiness ?? 'full',
      followUpNotes,
      ownerUserId: fullyReady ? null : ownerUserId || null,
      externalHandlerName: extName || null,
      externalHandlerContactPerson: extPerson || null,
      externalHandlerContactDetails: extDetails || null,
      reportedToOps,
      reportedToOpsRecipient: reportedToOps === 'yes' ? reportedToOpsRecipient : null,
      note,
      // Only meaningful on a genuine (full-readiness) close -- '' becomes
      // `undefined` (unanswered), which the schema's own superRefine
      // rejects with a clear Hebrew message when readiness === 'full'.
      confirmedCause: fullyReady ? confirmedCause || undefined : undefined,
      confirmedCauseOtherDetail: confirmedCauseOtherDetail || undefined,
      treatmentOutcome: fullyReady ? treatmentOutcome || undefined : undefined,
      treatmentOutcomeOtherDetail: treatmentOutcomeOtherDetail || undefined,
      resolutionAttribution: fullyReady ? effectiveResolutionAttribution || undefined : undefined,
      resolutionAttributionOtherDetail: resolutionAttributionOtherDetail || undefined,
      resolutionActionIds: outcomeForcesNoAction ? [] : resolutionActionIds,
      newTreatmentActions: outcomeForcesNoAction ? [] : newTreatmentActions,
    });

  const proceedToConfirm = () => {
    const boundsError = eventTimeBoundsError(localInputToIso(eventTime));
    if (boundsError) {
      setOwnerError(undefined);
      setExtError(undefined);
      setError(boundsError);
      return;
    }
    const parsed = parsedInput();
    if (!parsed.success) {
      const classificationPaths = new Set([
        'confirmedCause',
        'confirmedCauseOtherDetail',
        'treatmentOutcome',
        'treatmentOutcomeOtherDetail',
        'resolutionAttribution',
        'resolutionAttributionOtherDetail',
        'resolutionActionIds',
      ]);
      const ownerIssue = parsed.error.issues.find((i) => i.path[0] === 'ownerUserId');
      const extIssue = parsed.error.issues.find((i) => i.path[0] === 'externalHandlerName');
      const confirmedCauseIssue = parsed.error.issues.find(
        (i) => i.path[0] === 'confirmedCause' || i.path[0] === 'confirmedCauseOtherDetail',
      );
      const treatmentOutcomeIssue = parsed.error.issues.find(
        (i) => i.path[0] === 'treatmentOutcome' || i.path[0] === 'treatmentOutcomeOtherDetail',
      );
      const resolutionIssue = parsed.error.issues.find(
        (i) =>
          i.path[0] === 'resolutionAttribution' ||
          i.path[0] === 'resolutionAttributionOtherDetail' ||
          i.path[0] === 'resolutionActionIds',
      );
      const otherIssue = parsed.error.issues.find(
        (i) => i.path[0] !== 'ownerUserId' && i.path[0] !== 'externalHandlerName' && !classificationPaths.has(String(i.path[0])),
      );
      setOwnerError(ownerIssue?.message);
      setExtError(extIssue?.message);
      setConfirmedCauseError(confirmedCauseIssue?.message);
      setTreatmentOutcomeError(treatmentOutcomeIssue?.message);
      setResolutionAttributionError(resolutionIssue?.message);
      setError(otherIssue?.message);
      return;
    }
    setOwnerError(undefined);
    setExtError(undefined);
    setConfirmedCauseError(undefined);
    setTreatmentOutcomeError(undefined);
    setResolutionAttributionError(undefined);
    setError(undefined);
    setConfirming(true);
  };

  const confirm = () => {
    const parsed = parsedInput();
    if (parsed.success) onSubmit(parsed.data);
  };

  // Derived from the selected effective closure time (eventTime), not the
  // current clock -- this is a preview of the duration close_incident will
  // persist into closed_at (migration 0033), which must not drift with
  // however long the form stays open or how late the closure gets recorded.
  const estimatedDuration = formatDuration(incident.discoveredAt, localInputToIso(eventTime));

  return (
    <Dialog open={open} onClose={handleClose} title="סגירת תקלה" wide>
      {!confirming ? (
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); proceedToConfirm(); }}>
          <Field
            label="מועד סגירת התקלה בפועל"
            required
            hint="המועד שבו התקלה נסגרה בפועל, גם אם התיעוד נעשה מאוחר יותר."
          >
            {(a) => <DateTimeLocalInput {...a} value={eventTime} onChange={setEventTime} />}
          </Field>
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
                  onChange={setOwnerUserId}
                  error={ownerError}
                  legacyExternalName={!incident.ownerUserId ? incident.ownerExternalName : null}
                />
              </div>
            </>
          )}
          {/* Independent of readiness: a full-readiness closure can still
              record or update an external handling party -- OwnerField above
              is conditional, this is not. */}
          <ExternalPartyFields
            name={extName}
            contactPerson={extPerson}
            contactDetails={extDetails}
            onChangeName={setExtName}
            onChangeContactPerson={setExtPerson}
            onChangeContactDetails={setExtDetails}
            nameError={extError}
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
          <Field label="הערה נוספת">
            {(a) => (
              <>
                <Textarea
                  {...a}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={600}
                  placeholder="כל מידע נוסף שכדאי לתעד לצד סגירת התקלה (לא חובה)."
                />
                <p className="text-left text-xs text-muted">{note.length}/600</p>
              </>
            )}
          </Field>
          {fullyReady && (
            <div className="flex flex-col gap-3 rounded-xl border border-hairline p-3">
              <p className="text-sm font-semibold text-text-primary">סיווג סגירה</p>
              <Field label="הגורם שאומת" required error={confirmedCauseError}>
                {(a) => (
                  <Select
                    {...a}
                    value={confirmedCause}
                    onChange={(e) => setConfirmedCause(e.target.value as ConfirmedCause | '')}
                  >
                    <option value="">— בחירה —</option>
                    {CONFIRMED_CAUSE_ORDER.map((c) => (
                      <option key={c} value={c}>
                        {confirmedCauseLabels[c]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {confirmedCause === '' && suggestedConfirmedCause && (
                <button
                  type="button"
                  onClick={() => setConfirmedCause(suggestedConfirmedCause)}
                  className="self-start rounded-lg border border-brand-300 bg-brand-50 px-2.5 py-1.5 text-xs font-medium text-brand-900 hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950/50 dark:text-brand-200 dark:hover:bg-brand-900/60"
                >
                  החשד האחרון: {confirmedCauseLabels[suggestedConfirmedCause]} — לחיצה לבחירה
                </button>
              )}
              {confirmedCause === 'other' && (
                <Field label="פירוט הגורם שאומת" required>
                  {(a) => (
                    <Input
                      {...a}
                      value={confirmedCauseOtherDetail}
                      onChange={(e) => setConfirmedCauseOtherDetail(e.target.value)}
                      maxLength={500}
                    />
                  )}
                </Field>
              )}

              <Field label="תוצאת הטיפול" required error={treatmentOutcomeError}>
                {(a) => (
                  <Select
                    {...a}
                    value={treatmentOutcome}
                    onChange={(e) => {
                      const next = e.target.value as TreatmentOutcome | '';
                      setTreatmentOutcome(next);
                      if (next === 'resolved_without_action') {
                        setResolutionActionIds([]);
                        setNewTreatmentActions([]);
                      }
                    }}
                  >
                    <option value="">— בחירה —</option>
                    {TREATMENT_OUTCOME_ORDER.map((o) => (
                      <option key={o} value={o}>
                        {treatmentOutcomeLabels[o]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {treatmentOutcome === 'other' && (
                <Field label="פירוט תוצאת הטיפול" required>
                  {(a) => (
                    <Input
                      {...a}
                      value={treatmentOutcomeOtherDetail}
                      onChange={(e) => setTreatmentOutcomeOtherDetail(e.target.value)}
                      maxLength={500}
                    />
                  )}
                </Field>
              )}

              {outcomeForcesNoAction ? (
                <div className="rounded-lg border border-hairline bg-surface-active px-3 py-2 text-sm">
                  <p>
                    <strong>מה ידוע על מה שהוביל לפתרון:</strong> {resolutionAttributionLabels.no_action_taken}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    נגזר אוטומטית מתוצאת הטיפול שנבחרה. כדי לבחור אפשרות אחרת יש לשנות תחילה את תוצאת הטיפול.
                  </p>
                </div>
              ) : (
                <>
                  <Field label="מה ידוע על מה שהוביל לפתרון?" required error={resolutionAttributionError}>
                    {(a) => (
                      <Select
                        {...a}
                        value={resolutionAttribution}
                        onChange={(e) => {
                          const next = e.target.value as ResolutionAttribution | '';
                          setResolutionAttribution(next);
                          if (next !== 'specific_action' && next !== 'combination_of_actions') {
                            setResolutionActionIds([]);
                            setNewTreatmentActions([]);
                          }
                        }}
                      >
                        <option value="">— בחירה —</option>
                        {RESOLUTION_ATTRIBUTION_ORDER.map((r) => (
                          <option key={r} value={r}>
                            {resolutionAttributionLabels[r]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  {resolutionAttribution === 'other' && (
                    <Field label="פירוט" required>
                      {(a) => (
                        <Input
                          {...a}
                          value={resolutionAttributionOtherDetail}
                          onChange={(e) => setResolutionAttributionOtherDetail(e.target.value)}
                          maxLength={500}
                        />
                      )}
                    </Field>
                  )}
                  {(resolutionAttribution === 'specific_action' || resolutionAttribution === 'combination_of_actions') && (
                    <div className="flex flex-col gap-2 rounded-lg border border-hairline p-3">
                      {cycleActions.length > 0 && (
                        <fieldset className="flex flex-col gap-1.5">
                          <legend className="mb-1 text-xs font-semibold text-text-secondary">
                            פעולות שכבר תועדו בתקלה זו
                          </legend>
                          {cycleActions.map((act) => (
                            <label key={act.id} className="flex min-h-9 items-center gap-2 text-sm">
                              <input
                                type={resolutionAttribution === 'specific_action' ? 'radio' : 'checkbox'}
                                name="resolution-action"
                                checked={resolutionActionIds.includes(act.id)}
                                onChange={() => {
                                  if (resolutionAttribution === 'specific_action') {
                                    setResolutionActionIds([act.id]);
                                  } else {
                                    setResolutionActionIds((ids) =>
                                      ids.includes(act.id) ? ids.filter((x) => x !== act.id) : [...ids, act.id],
                                    );
                                  }
                                }}
                                className="size-4"
                              />
                              <span>
                                {treatmentActionTypeLabels[act.actionType]}
                                {act.actionType === 'other' && act.otherDetail ? ` — ${act.otherDetail}` : ''}
                              </span>
                            </label>
                          ))}
                        </fieldset>
                      )}
                      <TreatmentActionPicker
                        label="הוספת פעולה שלא תועדה קודם"
                        actions={newTreatmentActions}
                        onChange={setNewTreatmentActions}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <p className="text-sm text-muted">משך התקלה למועד הסגירה שנבחר: {estimatedDuration}</p>
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
            {fullyReady && confirmedCause && treatmentOutcome && (
              <>
                <p className="mt-1"><strong>הגורם שאומת:</strong> {confirmedCauseLabels[confirmedCause]}</p>
                <p className="mt-1"><strong>תוצאת הטיפול:</strong> {treatmentOutcomeLabels[treatmentOutcome]}</p>
              </>
            )}
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
