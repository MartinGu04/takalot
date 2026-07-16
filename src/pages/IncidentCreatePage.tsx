import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createIncidentSchema, type CreateIncidentInput } from '../domain/schemas';
import { useLocations, useProfiles, useSystems, useAppMutation, repo } from '../data/hooks';
import { useSession } from '../auth/AuthContext';
import { Button, Field, Input, Select, Textarea } from '../components/ui';
import { OwnerField } from '../components/OwnerField';
import { severityLabels, reportedToOpsLabels } from '../domain/labels';
import { isoToLocalInput, localInputToIso } from '../lib/time';
import { loadDraft, clearDraft, useDraft, useWarnOnUnload } from '../lib/useDraft';

const DRAFT_KEY = 'takalot-draft-incident-create';

type FormValues = {
  systemId: string;
  locationId: string;
  discoveredAt: string; // datetime-local
  description: string;
  severity: CreateIncidentInput['severity'];
  operationalImpact: string;
  actionsTaken: string;
  ownerUserId: string;
  ownerExternalName: string;
  status: CreateIncidentInput['status'];
  hasDeadline: boolean;
  nextUpdateDue: string; // datetime-local
  noDeadlineReason: string;
  reportedToOps: CreateIncidentInput['reportedToOps'];
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
    ownerExternalName: '',
    status: 'new',
    hasDeadline: true,
    nextUpdateDue: isoToLocalInput(new Date(Date.now() + 4 * 3600_000).toISOString()),
    noDeadlineReason: '',
    reportedToOps: 'no',
  };
}

export default function IncidentCreatePage() {
  const navigate = useNavigate();
  const session = useSession();
  const { data: systems } = useSystems();
  const { data: locations } = useLocations();
  const { data: profiles } = useProfiles();
  const [submitted, setSubmitted] = useState(false);

  const { register, handleSubmit, control, watch, formState, reset } = useForm<FormValues>({
    defaultValues: loadDraft<FormValues>(DRAFT_KEY) ?? defaultValues(),
  });
  const values = watch();
  useDraft(DRAFT_KEY, values, formState.isDirty && !submitted);
  useWarnOnUnload(formState.isDirty && !submitted);

  const [ownerError, setOwnerError] = useState<string | undefined>();
  const [deadlineError, setDeadlineError] = useState<string | undefined>();
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
    setDeadlineError(undefined);
    setValidationError(undefined);
    const input: CreateIncidentInput = {
      systemId: form.systemId,
      locationId: form.locationId,
      discoveredAt: localInputToIso(form.discoveredAt),
      description: form.description,
      severity: form.severity,
      operationalImpact: form.operationalImpact,
      actionsTaken: form.actionsTaken,
      status: form.status,
      ownerUserId: form.ownerUserId || null,
      ownerExternalName: form.ownerExternalName || null,
      nextUpdateDue: form.hasDeadline ? localInputToIso(form.nextUpdateDue) : null,
      noDeadlineReason: form.hasDeadline ? null : form.noDeadlineReason,
      reportedToOps: form.reportedToOps,
    };
    const parsed = createIncidentSchema.safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'ownerUserId') setOwnerError(issue.message);
        else if (issue.path[0] === 'nextUpdateDue') setDeadlineError(issue.message);
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

        <Field label="שעת גילוי" required>
          {(a) => <Input {...a} type="datetime-local" {...register('discoveredAt', { required: true })} />}
        </Field>

        <Field label="תיאור התקלה" required error={formState.errors.description?.message}>
          {(a) => (
            <Textarea
              {...a}
              rows={4}
              maxLength={4000}
              {...register('description', { required: 'יש להזין תיאור', validate: (v) => v.trim().length > 0 || 'יש להזין תיאור' })}
            />
          )}
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="חומרה" required>
            {(a) => (
              <Select {...a} {...register('severity')}>
                {Object.entries(severityLabels).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="סטטוס נוכחי" required>
            {(a) => (
              <Select {...a} {...register('status')}>
                <option value="new">חדשה</option>
                <option value="acknowledged">התקבלה</option>
                <option value="in_progress">בטיפול</option>
              </Select>
            )}
          </Field>
        </div>

        <Field label="השפעה מבצעית" required error={formState.errors.operationalImpact?.message}>
          {(a) => (
            <Textarea
              {...a}
              rows={2}
              maxLength={1000}
              {...register('operationalImpact', { required: 'יש להזין השפעה מבצעית', validate: (v) => v.trim().length > 0 || 'יש להזין השפעה מבצעית' })}
            />
          )}
        </Field>

        <Field label="פעולות שבוצעו עד כה" required error={formState.errors.actionsTaken?.message}>
          {(a) => (
            <Textarea
              {...a}
              rows={3}
              maxLength={4000}
              {...register('actionsTaken', { required: 'יש להזין פעולות שבוצעו', validate: (v) => v.trim().length > 0 || 'יש להזין פעולות שבוצעו' })}
            />
          )}
        </Field>

        <Controller
          control={control}
          name="ownerUserId"
          render={({ field: ownerField }) => (
            <Controller
              control={control}
              name="ownerExternalName"
              render={({ field: extField }) => (
                <OwnerField
                  profiles={profiles}
                  ownerUserId={ownerField.value}
                  ownerExternalName={extField.value}
                  onChangeInternal={ownerField.onChange}
                  onChangeExternal={extField.onChange}
                  error={ownerError}
                />
              )}
            />
          )}
        />

        <div className="surface p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" {...register('hasDeadline')} defaultChecked />
            יש צפי לעדכון הבא
          </label>
          {values.hasDeadline ? (
            <div className="mt-2">
              <Field label="צפי לעדכון הבא" error={deadlineError}>
                {(a) => <Input {...a} type="datetime-local" {...register('nextUpdateDue')} />}
              </Field>
            </div>
          ) : (
            <div className="mt-2">
              <Field label='נימוק ל"ללא צפי כרגע"' required error={deadlineError}>
                {(a) => <Input {...a} {...register('noDeadlineReason')} placeholder="לדוגמה: ממתין לבירור מול ספק" />}
              </Field>
            </div>
          )}
        </div>

        <Field label="דווח למבצעים">
          {(a) => (
            <Select {...a} {...register('reportedToOps')}>
              {Object.entries(reportedToOpsLabels).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          )}
        </Field>

        {validationError && (
          <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
            {validationError}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => reset(defaultValues())}>
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
