import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { createIncidentSchema, type CreateIncidentInput, type TreatmentActionInput } from '../domain/schemas';
import { useLocations, useProfiles, useSystems, useAppMutation, repo } from '../data/hooks';
import { useAuth, useSession } from '../auth/AuthContext';
import { Button, Disclosure, Field, Input, Select, Textarea, useToast } from '../components/ui';
import { ExternalPartyFields } from '../components/ExternalPartyFields';
import { OwnerField } from '../components/OwnerField';
import { TreatmentActionPicker } from '../components/TreatmentActionPicker';
import { SystemOptions, LocationOptions } from '../components/ReferenceDataOptions';
import { NotificationCopyDialog } from '../components/dialogs/NotificationCopyDialog';
import { SimilarIncidentSuggestions } from '../components/SimilarIncidentSuggestions';
import {
  severityLabels,
  reportedToOpsLabels,
  incidentDomainLabels,
  INCIDENT_DOMAIN_ORDER,
  suspectedCauseLabels,
  SUSPECTED_CAUSE_ORDER,
} from '../domain/labels';
import { buildIncidentOpenedMessage } from '../domain/notificationMessage';
import type { Incident, IncidentDomain, SimilarIncidentSuggestion, SuspectedCause } from '../domain/types';
import { isoToLocalInput, localInputToIso } from '../lib/time';
import { loadDraft, clearDraft, useDraft, useClearDraftOnRouteLeave, useWarnOnUnload } from '../lib/useDraft';

const DRAFT_KEY = 'takalot-draft-incident-create';
const CREATE_ROUTE = '/incidents/new';

type FormValues = {
  systemId: string;
  locationId: string;
  discoveredAt: string; // datetime-local
  description: string;
  severity: CreateIncidentInput['severity'];
  operationalImpact: string;
  actionsTaken: string;
  ownerUserId: string;
  externalHandlerName: string;
  externalHandlerContactPerson: string;
  externalHandlerContactDetails: string;
  reportedToOps: CreateIncidentInput['reportedToOps'];
  reportedToOpsRecipient: string;
  reportedToComms: 'no' | 'yes';
  reportedToCommsRecipient: string;
  wisdomReported: 'no' | 'yes';
  wisdomIncidentNumber: string;
  note: string;
  // תחום התקלה -- the one new required field. '' is the unselected
  // sentinel (never a real incidentDomainSchema member).
  reportedDomain: IncidentDomain | '';
  // Behind the "הוספת חשד ראשוני ופרטי טיפול" disclosure -- both entirely
  // optional; leaving them at their defaults sends no extra keys.
  initialSuspectedCause: SuspectedCause | '';
  initialSuspectedCauseOtherDetail: string;
  initialTreatmentActions: TreatmentActionInput[];
};

function defaultValues(): FormValues {
  return {
    systemId: '',
    locationId: '',
    discoveredAt: isoToLocalInput(new Date().toISOString()),
    description: '',
    severity: 'medium',
    operationalImpact: '',
    actionsTaken: '',
    ownerUserId: '',
    externalHandlerName: '',
    externalHandlerContactPerson: '',
    externalHandlerContactDetails: '',
    reportedToOps: 'no',
    reportedToOpsRecipient: '',
    reportedToComms: 'no',
    reportedToCommsRecipient: '',
    wisdomReported: 'no',
    wisdomIncidentNumber: '',
    note: '',
    reportedDomain: '',
    initialSuspectedCause: '',
    initialSuspectedCauseOtherDetail: '',
    initialTreatmentActions: [],
  };
}

export default function IncidentCreatePage() {
  const navigate = useNavigate();
  const session = useSession();
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: systems } = useSystems();
  const { data: locations } = useLocations();
  const { data: profiles } = useProfiles();
  const [submitted, setSubmitted] = useState(false);
  const [createdIncident, setCreatedIncident] = useState<Incident | null>(null);
  // Related-incident suggestions: purely local UI state until the incident
  // is successfully created -- selecting "קשר לתקלה זו" never itself calls
  // the database. Keyed by incidentId (not just a Set) so the post-creation
  // linking pass and its partial-failure message can reference each
  // suggestion's number without a second lookup.
  const [selectedRelations, setSelectedRelations] = useState<Map<string, SimilarIncidentSuggestion>>(new Map());
  const [dismissedRelationIds, setDismissedRelationIds] = useState<Set<string>>(new Set());

  // Merge a restored draft OVER the current defaults rather than using it
  // directly: a draft saved before a later form revision (e.g. PR C's
  // external-handler fields) won't have those keys at all, and using it
  // as-is would leave them `undefined` -- an uncontrolled input value,
  // not the `''` every field here expects. Merging keeps every value the
  // draft does have while filling in anything it predates.
  const { register, handleSubmit, watch, formState, reset, setValue } = useForm<FormValues>({
    defaultValues: { ...defaultValues(), ...loadDraft<FormValues>(DRAFT_KEY) },
  });
  const values = watch();
  useDraft(DRAFT_KEY, values, formState.isDirty && !submitted);
  useClearDraftOnRouteLeave(DRAFT_KEY, CREATE_ROUTE);
  useWarnOnUnload(formState.isDirty && !submitted);

  // Defaults "בעל אחריות פנימי" to the signed-in user, but only once (and
  // only for as long as the user hasn't picked someone else themselves this
  // session) -- a manual selection (tracked via this ref, not form
  // dirtiness, so it survives even a value that happens to equal the
  // default) always wins, and the ref itself resets to false on every fresh
  // mount and on "איפוס", so the default is re-applied then.
  const ownerManuallySetRef = useRef(false);
  useEffect(() => {
    if (ownerManuallySetRef.current || !profiles) return;
    const eligible = profiles.find((p) => p.id === session.userId && p.active);
    if (eligible && values.ownerUserId !== eligible.id) {
      setValue('ownerUserId', eligible.id);
    }
  }, [profiles, session.userId, values.ownerUserId, setValue]);

  const [ownerError, setOwnerError] = useState<string | undefined>();
  const [extError, setExtError] = useState<string | undefined>();
  const [recipientError, setRecipientError] = useState<string | undefined>();
  const [commsRecipientError, setCommsRecipientError] = useState<string | undefined>();
  const [wisdomNumberError, setWisdomNumberError] = useState<string | undefined>();
  const [noteError, setNoteError] = useState<string | undefined>();
  const [domainError, setDomainError] = useState<string | undefined>();
  const [initialCauseOtherError, setInitialCauseOtherError] = useState<string | undefined>();
  const [validationError, setValidationError] = useState<string | undefined>();
  // Collapsed by default -- forced open (never re-collapsed automatically)
  // the moment a validation error touches a field inside it, so an error
  // is never left hidden below a closed disclosure.
  const [classificationOpen, setClassificationOpen] = useState(false);

  const createMutation = useAppMutation(
    async (input: CreateIncidentInput) => repo().createIncident(session, input),
    {
      onSuccess: (incident) => {
        setSubmitted(true);
        clearDraft(DRAFT_KEY);
        // Navigation to the new incident's own page is deferred until the
        // WhatsApp notification-copy modal below is dismissed -- the modal
        // must appear right after the confirmed success, built from this
        // exact persisted incident (not the form's now-stale local state).
        setCreatedIncident(incident);
        // The incident is already fully, successfully created at this
        // point -- everything below is best-effort enrichment, called
        // directly against repo() (not another useAppMutation) specifically
        // so each attempt is isolated: Promise.allSettled, never
        // Promise.all -- one failing must never roll back the incident,
        // and must never affect any OTHER selected relation that already
        // succeeded. ['incident-relations'] is invalidated manually once
        // every attempt settles, so the incident's own detail page (reached
        // after the notification modal below) shows the current, real
        // relation state -- never stale.
        if (selectedRelations.size > 0) {
          const attempts = Array.from(selectedRelations.values());
          void Promise.allSettled(
            attempts.map((s) => repo().linkIncidentOnCreation(session, incident.id, s.incidentId)),
          ).then((results) => {
            queryClient.invalidateQueries({ queryKey: ['incident-relations'] });
            const failed = results.filter((r) => r.status === 'rejected').length;
            const succeeded = attempts.length - failed;
            if (failed === 0) return;
            toast(
              succeeded > 0
                ? `התקלה נפתחה בהצלחה. קושרה ל-${succeeded} מתוך ${attempts.length} תקלות שנבחרו -- ניתן להשלים ידנית מעמוד התקלה.`
                : 'התקלה נפתחה בהצלחה, אך הקישור לתקלות שנבחרו נכשל. ניתן לקשר ידנית מעמוד התקלה.',
              'error',
            );
          });
        }
      },
    },
  );

  const onSubmit = (form: FormValues) => {
    setOwnerError(undefined);
    setExtError(undefined);
    setRecipientError(undefined);
    setCommsRecipientError(undefined);
    setWisdomNumberError(undefined);
    setNoteError(undefined);
    setDomainError(undefined);
    setInitialCauseOtherError(undefined);
    setValidationError(undefined);
    const input: CreateIncidentInput = {
      systemId: form.systemId,
      locationId: form.locationId,
      discoveredAt: localInputToIso(form.discoveredAt),
      description: form.description,
      severity: form.severity,
      operationalImpact: form.operationalImpact,
      actionsTaken: form.actionsTaken,
      // Every newly created incident enters directly as "בטיפול" -- the
      // status picker was removed from this form. create_incident's own
      // allowlist still technically accepts 'new'/'acknowledged' for
      // backend/historical compatibility; this form simply never sends them.
      status: 'in_progress',
      ownerUserId: form.ownerUserId || null,
      ownerExternalName: null,
      externalHandlerName: form.externalHandlerName || null,
      externalHandlerContactPerson: form.externalHandlerContactPerson || null,
      externalHandlerContactDetails: form.externalHandlerContactDetails || null,
      reportedToOps: form.reportedToOps,
      reportedToOpsRecipient: form.reportedToOps === 'yes' ? form.reportedToOpsRecipient : null,
      reportedToComms: form.reportedToComms === 'yes',
      reportedToCommsRecipient: form.reportedToComms === 'yes' ? form.reportedToCommsRecipient : null,
      wisdomReported: form.wisdomReported === 'yes',
      wisdomIncidentNumber: form.wisdomReported === 'yes' ? form.wisdomIncidentNumber : null,
      note: form.note,
      reportedDomain: (form.reportedDomain || undefined) as CreateIncidentInput['reportedDomain'],
      // Omitted entirely (not merely nullable) when the disclosure was left
      // untouched -- both `undefined` here, matching "leaving the optional
      // section untouched sends no extra keys."
      initialSuspectedCause: form.initialSuspectedCause || undefined,
      initialSuspectedCauseOtherDetail: form.initialSuspectedCauseOtherDetail || undefined,
      initialTreatmentActions: form.initialTreatmentActions,
    };
    const parsed = createIncidentSchema.safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'ownerUserId') setOwnerError(issue.message);
        else if (issue.path[0] === 'externalHandlerName') setExtError(issue.message);
        else if (issue.path[0] === 'reportedToOpsRecipient') setRecipientError(issue.message);
        else if (issue.path[0] === 'reportedToCommsRecipient') setCommsRecipientError(issue.message);
        else if (issue.path[0] === 'wisdomIncidentNumber') setWisdomNumberError(issue.message);
        else if (issue.path[0] === 'note') setNoteError(issue.message);
        else if (issue.path[0] === 'reportedDomain') setDomainError(issue.message);
        else if (issue.path[0] === 'initialSuspectedCauseOtherDetail' || issue.path[0] === 'initialTreatmentActions') {
          setInitialCauseOtherError(issue.message);
          setClassificationOpen(true);
        } else setValidationError(issue.message);
      }
      return;
    }
    createMutation.mutate(parsed.data);
  };

  const toggleRelationSelected = (suggestion: SimilarIncidentSuggestion) => {
    setSelectedRelations((prev) => {
      const next = new Map(prev);
      if (next.has(suggestion.incidentId)) next.delete(suggestion.incidentId);
      else next.set(suggestion.incidentId, suggestion);
      return next;
    });
  };

  const dismissRelationSuggestion = (incidentId: string) => {
    setDismissedRelationIds((prev) => new Set(prev).add(incidentId));
  };

  // Prevent accidental double submission
  const submitting = createMutation.isPending;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="page-title">פתיחת תקלה</h1>
      <p className="mt-1 text-sm text-muted">מספר התקלה יוקצה אוטומטית עם השמירה.</p>
      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!submitting) handleSubmit(onSubmit)(e);
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="מערכת / עמדה" required error={formState.errors.systemId?.message}>
            {(a) => (
              <Select {...a} {...register('systemId', { required: 'יש לבחור מערכת / עמדה' })}>
                <option value="">— בחירה —</option>
                <SystemOptions systems={systems} />
              </Select>
            )}
          </Field>
          <Field label="מיקום" required error={formState.errors.locationId?.message}>
            {(a) => (
              <Select {...a} {...register('locationId', { required: 'יש לבחור מיקום' })}>
                <option value="">— בחירה —</option>
                <LocationOptions locations={locations} />
              </Select>
            )}
          </Field>
        </div>

        <Field label="תחום התקלה" required error={domainError}>
          {(a) => (
            <Select {...a} {...register('reportedDomain', { required: 'יש לבחור תחום תקלה' })}>
              <option value="">— בחירה —</option>
              {INCIDENT_DOMAIN_ORDER.map((d) => (
                <option key={d} value={d}>
                  {incidentDomainLabels[d]}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label="מועד גילוי התקלה בפועל"
          required
          hint="מועד שבו התקלה התגלתה בפועל בשטח — לא מועד תיעוד התקלה במערכת. ניתן לערוך לצורך תיעוד מאוחר."
        >
          {(a) => <Input {...a} type="datetime-local" {...register('discoveredAt', { required: true })} />}
        </Field>

        <Field label="תיאור התקלה" required error={formState.errors.description?.message}>
          {(a) => (
            <>
              <Textarea
                {...a}
                rows={4}
                maxLength={400}
                placeholder="מה קרה, ומתי לראשונה הבחינו בכך?"
                {...register('description', { required: 'יש להזין תיאור', validate: (v) => v.trim().length > 0 || 'יש להזין תיאור' })}
              />
              <p className="text-left text-xs text-muted">{values.description.length}/400</p>
            </>
          )}
        </Field>

        <SimilarIncidentSuggestions
          systemId={values.systemId}
          locationId={values.locationId}
          reportedDomain={values.reportedDomain}
          description={values.description}
          selectedIds={new Set(selectedRelations.keys())}
          dismissedIds={dismissedRelationIds}
          onToggleSelect={toggleRelationSelected}
          onDismiss={dismissRelationSuggestion}
        />

        <Field label="חומרה" required>
          {(a) => (
            <Select {...a} {...register('severity')}>
              {Object.entries(severityLabels).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="השפעה מבצעית" required error={formState.errors.operationalImpact?.message}>
          {(a) => (
            <>
              <Textarea
                {...a}
                rows={2}
                maxLength={400}
                placeholder="כיצד התקלה משפיעה בפועל על הפעילות, השירות או המשתמשים?"
                {...register('operationalImpact', { required: 'יש להזין השפעה מבצעית', validate: (v) => v.trim().length > 0 || 'יש להזין השפעה מבצעית' })}
              />
              <p className="text-left text-xs text-muted">{values.operationalImpact.length}/400</p>
            </>
          )}
        </Field>

        <Field label="פירוט הפעולות שבוצעו עד כה" required error={formState.errors.actionsTaken?.message}>
          {(a) => (
            <>
              <Textarea
                {...a}
                rows={3}
                maxLength={600}
                placeholder="אילו בדיקות או פעולות כבר בוצעו לפני תיעוד התקלה?"
                {...register('actionsTaken', { required: 'יש להזין פעולות שבוצעו', validate: (v) => v.trim().length > 0 || 'יש להזין פעולות שבוצעו' })}
              />
              <p className="text-left text-xs text-muted">{values.actionsTaken.length}/600</p>
            </>
          )}
        </Field>

        <Disclosure
          label="הוספת חשד ראשוני ופרטי טיפול"
          open={classificationOpen}
          onOpenChange={setClassificationOpen}
        >
          <Field label="חשד ראשוני (אופציונלי)">
            {(a) => (
              <Select
                {...a}
                value={values.initialSuspectedCause}
                onChange={(e) => setValue('initialSuspectedCause', e.target.value as SuspectedCause | '')}
              >
                <option value="">— לא צוין —</option>
                {SUSPECTED_CAUSE_ORDER.map((c) => (
                  <option key={c} value={c}>
                    {suspectedCauseLabels[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {values.initialSuspectedCause === 'other' && (
            <Field label="פירוט החשד" required error={initialCauseOtherError}>
              {(a) => (
                <Input
                  {...a}
                  value={values.initialSuspectedCauseOtherDetail}
                  onChange={(e) => setValue('initialSuspectedCauseOtherDetail', e.target.value)}
                  maxLength={500}
                />
              )}
            </Field>
          )}
          <TreatmentActionPicker
            label="סיווג הפעולות שתוארו למעלה"
            hint="אין צורך לכתוב שוב — בחר רק את סוגי הפעולות לצורך מעקב וניתוח."
            actions={values.initialTreatmentActions}
            onChange={(actions) => setValue('initialTreatmentActions', actions)}
          />
        </Disclosure>

        <OwnerField
          profiles={profiles}
          ownerUserId={values.ownerUserId}
          onChange={(v) => {
            ownerManuallySetRef.current = true;
            setValue('ownerUserId', v);
          }}
          error={ownerError}
          hint="האחראי לוודא שהטיפול בתקלה יימשך עד לסגירתה — לאו דווקא מי שמבצע את התיקון הטכני עצמו."
        />

        <ExternalPartyFields
          name={values.externalHandlerName}
          contactPerson={values.externalHandlerContactPerson}
          contactDetails={values.externalHandlerContactDetails}
          onChangeName={(v) => setValue('externalHandlerName', v)}
          onChangeContactPerson={(v) => setValue('externalHandlerContactPerson', v)}
          onChangeContactDetails={(v) => setValue('externalHandlerContactDetails', v)}
          nameError={extError}
        />

        <Field label="דווח למבצעים">
          {(a) => (
            <Select
              {...a}
              {...register('reportedToOps', {
                onChange: (e) => {
                  if (e.target.value !== 'yes') setValue('reportedToOpsRecipient', '');
                },
              })}
            >
              {Object.entries(reportedToOpsLabels).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          )}
        </Field>

        {values.reportedToOps === 'yes' && (
          <Field label="למי דווח?" required error={recipientError}>
            {(a) => (
              <Input
                {...a}
                {...register('reportedToOpsRecipient')}
                placeholder="לדוגמה: אחמ״ש מוקד מבצעים / שם"
                maxLength={200}
              />
            )}
          </Field>
        )}

        <Field label="האם דווח לתקשוב למבצעים?">
          {(a) => (
            <Select
              {...a}
              {...register('reportedToComms', {
                onChange: (e) => {
                  if (e.target.value !== 'yes') setValue('reportedToCommsRecipient', '');
                },
              })}
            >
              <option value="no">לא</option>
              <option value="yes">כן</option>
            </Select>
          )}
        </Field>

        {values.reportedToComms === 'yes' && (
          <Field label="למי דווח?" required error={commsRecipientError}>
            {(a) => (
              <Input
                {...a}
                {...register('reportedToCommsRecipient')}
                placeholder="לדוגמה: תקשוב מוקד מבצעים / שם"
                maxLength={200}
              />
            )}
          </Field>
        )}

        <Field label="האם נפתחה תקלה ב-WISDOM?">
          {(a) => (
            <Select
              {...a}
              {...register('wisdomReported', {
                onChange: (e) => {
                  if (e.target.value !== 'yes') setValue('wisdomIncidentNumber', '');
                },
              })}
            >
              <option value="no">לא</option>
              <option value="yes">כן</option>
            </Select>
          )}
        </Field>

        {values.wisdomReported === 'yes' && (
          <Field label="מספר תקלה ב-WISDOM" required error={wisdomNumberError}>
            {(a) => (
              <Input
                {...a}
                {...register('wisdomIncidentNumber')}
                placeholder="לדוגמה: WISDOM-12345"
                maxLength={100}
              />
            )}
          </Field>
        )}

        <Field label="הערה נוספת" error={noteError}>
          {(a) => (
            <>
              <Textarea
                {...a}
                rows={2}
                maxLength={600}
                placeholder="כל מידע נוסף שכדאי לתעד לצד פתיחת התקלה (לא חובה)."
                {...register('note')}
              />
              <p className="text-left text-xs text-muted">{values.note.length}/600</p>
            </>
          )}
        </Field>

        {validationError && (
          <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
            {validationError}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              ownerManuallySetRef.current = false;
              setClassificationOpen(false);
              setSelectedRelations(new Map());
              setDismissedRelationIds(new Set());
              reset(defaultValues());
            }}
          >
            איפוס
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'שומר…' : 'פתיחת תקלה'}
          </Button>
        </div>
      </form>

      {createdIncident && user && (
        <NotificationCopyDialog
          open
          title="התקלה נפתחה בהצלחה"
          message={buildIncidentOpenedMessage(
            createdIncident,
            systems?.find((s) => s.id === createdIncident.systemId)?.name ?? '—',
            user.fullName,
          )}
          onDismiss={() => navigate(`/incidents/${createdIncident.id}`, { state: { justCreated: true } })}
        />
      )}
    </div>
  );
}
