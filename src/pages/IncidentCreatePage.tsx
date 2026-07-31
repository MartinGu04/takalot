import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createIncidentSchema, type CreateIncidentInput } from '../domain/schemas';
import { useLocations, useProfiles, useSystems, useAppMutation, repo } from '../data/hooks';
import { useSession } from '../auth/AuthContext';
import { Button, Field, Input, Select, Textarea } from '../components/ui';
import { ExternalPartyFields } from '../components/ExternalPartyFields';
import { severityLabels, reportedToOpsLabels } from '../domain/labels';
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
  };
}

export default function IncidentCreatePage() {
  const navigate = useNavigate();
  const session = useSession();
  const { data: systems } = useSystems();
  const { data: locations } = useLocations();
  const { data: profiles } = useProfiles();
  const [submitted, setSubmitted] = useState(false);

  const { register, handleSubmit, watch, formState, reset, setValue } = useForm<FormValues>({
    defaultValues: loadDraft<FormValues>(DRAFT_KEY) ?? defaultValues(),
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
  const [validationError, setValidationError] = useState<string | undefined>();

  const createMutation = useAppMutation(
    async (input: CreateIncidentInput) => repo().createIncident(session, input),
    {
      onSuccess: (incident) => {
        setSubmitted(true);
        clearDraft(DRAFT_KEY);
        navigate(`/incidents/${incident.id}`, { state: { justCreated: true } });
      },
    },
  );

  const onSubmit = (form: FormValues) => {
    setOwnerError(undefined);
    setExtError(undefined);
    setRecipientError(undefined);
    setCommsRecipientError(undefined);
    setWisdomNumberError(undefined);
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
    };
    const parsed = createIncidentSchema.safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'ownerUserId') setOwnerError(issue.message);
        else if (issue.path[0] === 'externalHandlerName') setExtError(issue.message);
        else if (issue.path[0] === 'reportedToOpsRecipient') setRecipientError(issue.message);
        else if (issue.path[0] === 'reportedToCommsRecipient') setCommsRecipientError(issue.message);
        else if (issue.path[0] === 'wisdomIncidentNumber') setWisdomNumberError(issue.message);
        else setValidationError(issue.message);
      }
      return;
    }
    createMutation.mutate(parsed.data);
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
                {systems?.filter((s) => !s.archived).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="מיקום" required error={formState.errors.locationId?.message}>
            {(a) => (
              <Select {...a} {...register('locationId', { required: 'יש לבחור מיקום' })}>
                <option value="">— בחירה —</option>
                {locations?.filter((l) => !l.archived).map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>

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

        <Field label="פעולות שבוצעו עד כה" required error={formState.errors.actionsTaken?.message}>
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

        <Field
          label="בעל אחריות פנימי"
          required
          error={ownerError}
          hint="האחראי לוודא שהטיפול בתקלה יימשך עד לסגירתה — לאו דווקא מי שמבצע את התיקון הטכני עצמו."
        >
          {(a) => (
            <Select
              {...a}
              {...register('ownerUserId', {
                onChange: () => {
                  ownerManuallySetRef.current = true;
                },
              })}
            >
              <option value="">— בחירה —</option>
              {profiles?.filter((p) => p.active).map((p) => (
                <option key={p.id} value={p.id}>{p.fullName}</option>
              ))}
            </Select>
          )}
        </Field>

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
    </div>
  );
}
