import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIncidents, useLocations, useProfiles, useSystems, useAppMutation, repo } from '../data/hooks';
import { useAuth, useSession } from '../auth/AuthContext';
import { isOpen } from '../domain/types';
import { createHandoverSchema, type CreateHandoverInput } from '../domain/schemas';
import { SeverityBadge, StatusBadge, ownerDisplay } from '../components/incident';
import { Button, Field, Select, Textarea, Spinner } from '../components/ui';

export default function HandoverCreatePage() {
  const { user } = useAuth();
  const session = useSession();
  const navigate = useNavigate();
  const { data: incidents, isLoading } = useIncidents({}, 'priority');
  const { data: profiles } = useProfiles();
  const { data: systems } = useSystems();
  const { data: locations } = useLocations();

  const [toUserId, setToUserId] = useState('');
  const [generalNote, setGeneralNote] = useState('');
  const [itemNotes, setItemNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();

  const included = useMemo(
    () => (incidents ?? []).filter((i) => isOpen(i.status) || (i.followUpRequired && !i.followUpCompletedAt)),
    [incidents],
  );

  const candidates = (profiles ?? []).filter(
    (p) => p.active && p.id !== user?.id && ['shift_supervisor', 'professional_manager', 'system_admin'].includes(p.role),
  );

  const createMutation = useAppMutation(
    (input: CreateHandoverInput) => repo().createHandover(session, input),
    {
      successText: 'העברת המשמרת נוצרה ונשלחה לאישור.',
      invalidate: [['handovers'], ['incidents']],
      onSuccess: (h) => navigate(`/handovers/${h.id}`),
    },
  );

  const submit = () => {
    const parsed = createHandoverSchema.safeParse({ toUserId, generalNote, itemNotes });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    setError(undefined);
    createMutation.mutate(parsed.data);
  };

  if (isLoading) return <Spinner label="טוען תקלות לצילום מצב…" />;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold">יצירת העברת משמרת</h1>
      <p className="mt-1 text-sm text-neutral-500">
        ההעברה תכלול אוטומטית את כל התקלות הפתוחות ואת התקלות הסגורות עם כשירות לא מלאה.
      </p>

      <div className="mt-4 flex flex-col gap-3">
        <Field label="אחמ״ש נכנס" required>
          {(a) => (
            <Select {...a} value={toUserId} onChange={(e) => setToUserId(e.target.value)}>
              <option value="">— בחירה —</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>{p.fullName}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="הערה כללית">
          {(a) => <Textarea {...a} value={generalNote} onChange={(e) => setGeneralNote(e.target.value)} maxLength={2000} />}
        </Field>
      </div>

      <h2 className="mt-6 mb-2 text-lg font-bold">תקלות בהעברה ({included.length})</h2>
      <div className="flex flex-col gap-3">
        {included.map((i) => (
          <div key={i.id} className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold">{i.number}</span>
              <span>{systems?.find((s) => s.id === i.systemId)?.name}</span>
              <span className="ms-auto flex gap-1.5">
                <SeverityBadge severity={i.severity} />
                <StatusBadge status={i.status} />
              </span>
            </div>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
              {locations?.find((l) => l.id === i.locationId)?.name} · גורם מטפל: {ownerDisplay(i, profiles)}
            </p>
            <div className="mt-2">
              <Field label="הערת מסירה לתקלה זו (לא חובה)">
                {(a) => (
                  <Textarea
                    {...a}
                    rows={2}
                    value={itemNotes[i.id] ?? ''}
                    onChange={(e) => setItemNotes((n) => ({ ...n, [i.id]: e.target.value }))}
                    maxLength={1000}
                  />
                )}
              </Field>
            </div>
          </div>
        ))}
      </div>

      {error && <p role="alert" className="mt-3 text-sm font-medium text-red-700 dark:text-red-400">{error}</p>}

      <div className="mt-6 flex justify-end">
        <Button onClick={submit} disabled={createMutation.isPending}>
          {createMutation.isPending ? 'שולח…' : 'שליחת העברת משמרת'}
        </Button>
      </div>
    </div>
  );
}
