// System administrator screen: systems/positions, locations, audit log.
// User/personnel management lives on the dedicated כוח אדם page (/personnel).
import { useState, type FormEvent } from 'react';
import { useSession } from '../auth/AuthContext';
import { useProfiles, useSystems, useLocations, useAuditLogs, useAppMutation, repo } from '../data/hooks';
import { Badge, Button, Dialog, EmptyState, ErrorState, Field, Input, Spinner, useToast } from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';
import type { LocationRecord, SystemRecord } from '../domain/types';
import { formatDateTime } from '../lib/time';

type ConfigKind = 'systems' | 'locations';
type ConfigRecord = SystemRecord | LocationRecord;

const CONFIG_COPY = {
  systems: {
    singular: 'מערכת / עמדה',
    plural: 'מערכות / עמדות',
    createLabel: 'שם מערכת / עמדה חדשה',
    empty: 'עדיין לא הוגדרו מערכות / עמדות',
    created: 'המערכת / העמדה נוספה בהצלחה.',
    deleted: 'המערכת / העמדה נמחקה לצמיתות משום שלא הייתה בשימוש.',
    archivedByDelete: 'המערכת / העמדה נמצאת בשימוש ולכן הועברה למצב לא פעיל ולא נמחקה.',
  },
  locations: {
    singular: 'מיקום',
    plural: 'מיקומים',
    createLabel: 'שם מיקום חדש',
    empty: 'עדיין לא הוגדרו מיקומים',
    created: 'המיקום נוסף בהצלחה.',
    deleted: 'המיקום נמחק לצמיתות משום שלא היה בשימוש.',
    archivedByDelete: 'המיקום נמצא בשימוש ולכן הועבר למצב לא פעיל ולא נמחק.',
  },
} as const;

function ConfigTab({ kind }: { kind: ConfigKind }) {
  const session = useSession();
  const systemsQ = useSystems();
  const locationsQ = useLocations();
  const query = kind === 'systems' ? systemsQ : locationsQ;
  const data = query.data;
  const copy = CONFIG_COPY[kind];
  const toast = useToast();
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<ConfigRecord | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirming, setConfirming] = useState<
    { type: 'deactivate' | 'delete'; record: ConfigRecord } | null
  >(null);

  const create = useAppMutation(
    (n: string) => (kind === 'systems' ? repo().createSystem(session, n) : repo().createLocation(session, n)),
    {
      successText: copy.created,
      invalidate: [[kind]],
      onSuccess: () => setName(''),
    },
  );
  const rename = useAppMutation(
    (vars: { id: string; name: string }) =>
      kind === 'systems'
        ? repo().renameSystem(session, vars.id, vars.name)
        : repo().renameLocation(session, vars.id, vars.name),
    {
      successText: 'השם עודכן בהצלחה.',
      invalidate: [[kind]],
      onSuccess: () => setRenaming(null),
    },
  );
  const move = useAppMutation(
    (vars: { id: string; direction: 'up' | 'down' }) =>
      kind === 'systems'
        ? repo().moveSystem(session, vars.id, vars.direction)
        : repo().moveLocation(session, vars.id, vars.direction),
    { successText: 'סדר התצוגה עודכן.', invalidate: [[kind]] },
  );
  const setArchived = useAppMutation(
    (vars: { id: string; archived: boolean }) =>
      kind === 'systems'
        ? repo().setSystemArchived(session, vars.id, vars.archived)
        : repo().setLocationArchived(session, vars.id, vars.archived),
    {
      successText: 'המצב עודכן בהצלחה.',
      invalidate: [[kind]],
      onSuccess: () => setConfirming(null),
    },
  );
  const remove = useAppMutation(
    (id: string) =>
      kind === 'systems' ? repo().deleteSystem(session, id) : repo().deleteLocation(session, id),
    {
      invalidate: [[kind]],
      onSuccess: (outcome) => {
        setConfirming(null);
        toast(
          outcome === 'deleted' ? copy.deleted : copy.archivedByDelete,
          'success',
        );
      },
    },
  );

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && !create.isPending) create.mutate(name);
  };

  const openRename = (record: ConfigRecord) => {
    setRenaming(record);
    setRenameValue(record.name);
  };

  const busy =
    create.isPending || rename.isPending || move.isPending || setArchived.isPending || remove.isPending;

  return (
    <div>
      <form
        onSubmit={submitCreate}
        className="surface mb-4 grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto]"
      >
        <Field label={copy.createLabel} required hint="השם נשמר לאחר הסרת רווחים בתחילתו ובסופו.">
          {(a) => (
            <Input
              {...a}
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={create.isPending}
            />
          )}
        </Field>
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          {create.isPending ? 'מוסיף…' : 'הוספה'}
        </Button>
      </form>

      {query.isLoading ? (
        <Spinner label={`טוען ${copy.plural}…`} />
      ) : query.isError ? (
        <ErrorState message={`שגיאה בטעינת ${copy.plural}.`} onRetry={() => query.refetch()} />
      ) : (data ?? []).length === 0 ? (
        <EmptyState title={copy.empty} subtitle="ניתן להוסיף את הפריט הראשון בטופס למעלה." />
      ) : (
        <div className="flex flex-col gap-3" aria-label={`רשימת ${copy.plural}`}>
          {(data ?? []).map((record, index) => (
            <article key={record.id} className="surface p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className={`break-words font-semibold ${record.archived ? 'text-muted' : ''}`}>
                      {record.name}
                    </h2>
                    <Badge color={record.archived ? 'neutral' : 'green'}>
                      {record.archived ? 'לא פעיל' : 'פעיל'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted">סדר תצוגה: {record.displayOrder}</p>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:justify-end">
                  <Button
                    variant="secondary"
                    className="px-3"
                    disabled={busy || index === 0}
                    aria-label={`הזזת ${record.name} למעלה`}
                    onClick={() => move.mutate({ id: record.id, direction: 'up' })}
                  >
                    ↑ למעלה
                  </Button>
                  <Button
                    variant="secondary"
                    className="px-3"
                    disabled={busy || index === (data?.length ?? 0) - 1}
                    aria-label={`הזזת ${record.name} למטה`}
                    onClick={() => move.mutate({ id: record.id, direction: 'down' })}
                  >
                    ↓ למטה
                  </Button>
                  <Button variant="secondary" className="px-3" disabled={busy} onClick={() => openRename(record)}>
                    שינוי שם
                  </Button>
                  {record.archived ? (
                    <Button
                      variant="secondary"
                      className="px-3"
                      disabled={busy}
                      onClick={() => setArchived.mutate({ id: record.id, archived: false })}
                    >
                      הפעלה מחדש
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      className="px-3"
                      disabled={busy}
                      onClick={() => setConfirming({ type: 'deactivate', record })}
                    >
                      השבתה
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    className="px-3 text-red-700 dark:text-red-400"
                    disabled={busy}
                    onClick={() => setConfirming({ type: 'delete', record })}
                  >
                    מחיקה
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      <Dialog open={!!renaming} onClose={() => !rename.isPending && setRenaming(null)} title={`שינוי שם ${copy.singular}`}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (renaming && renameValue.trim() && !rename.isPending) {
              rename.mutate({ id: renaming.id, name: renameValue });
            }
          }}
        >
          <Field label="שם חדש" required>
            {(a) => (
              <Input
                {...a}
                maxLength={120}
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                disabled={rename.isPending}
              />
            )}
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="submit" disabled={!renameValue.trim() || rename.isPending}>
              {rename.isPending ? 'שומר…' : 'שמירת השם'}
            </Button>
            <Button variant="secondary" disabled={rename.isPending} onClick={() => setRenaming(null)}>
              ביטול
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={confirming?.type === 'deactivate'}
        onClose={() => !setArchived.isPending && setConfirming(null)}
        title={`השבתת ${copy.singular}`}
        message={
          <>
            <strong>{confirming?.record.name}</strong> לא תופיע בבחירה בעת פתיחת תקלה חדשה. תקלות קיימות
            ימשיכו להציג אותה, וניתן יהיה להפעיל אותה מחדש.
          </>
        }
        confirmLabel="השבתה"
        submitting={setArchived.isPending}
        onConfirm={() =>
          confirming && setArchived.mutate({ id: confirming.record.id, archived: true })
        }
      />

      <ConfirmDialog
        open={confirming?.type === 'delete'}
        onClose={() => !remove.isPending && setConfirming(null)}
        title={`מחיקת ${copy.singular}`}
        message={
          <>
            בקשת המחיקה של <strong>{confirming?.record.name}</strong> נבדקת בשרת. פריט שלא היה בשימוש
            יימחק לצמיתות; פריט שמקושר לתקלה או לרשומה היסטורית יישמר ויועבר למצב לא פעיל.
          </>
        }
        confirmLabel="בקשת מחיקה"
        danger
        submitting={remove.isPending}
        onConfirm={() => confirming && remove.mutate(confirming.record.id)}
      />
    </div>
  );
}

function AuditTab() {
  const [incidentNumber, setIncidentNumber] = useState('');
  const [action, setAction] = useState('');
  const { data: logs, isLoading } = useAuditLogs({ incidentNumber: incidentNumber || undefined, action: action || undefined }, true);
  const { data: profiles } = useProfiles();
  const name = (id: string | null) => (id ? (profiles?.find((p) => p.id === id)?.fullName ?? id) : 'המערכת');

  return (
    <div>
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Input placeholder="סינון לפי מספר תקלה…" value={incidentNumber} onChange={(e) => setIncidentNumber(e.target.value)} />
        <Input placeholder="סינון לפי סוג פעולה…" value={action} onChange={(e) => setAction(e.target.value)} />
      </div>
      {isLoading ? (
        <Spinner />
      ) : (logs ?? []).length === 0 ? (
        <EmptyState title="אין רישומי יומן התואמים לסינון" />
      ) : (
        <div className="overflow-x-auto surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-active text-right">
              <tr>
                <th className="p-2">זמן</th>
                <th className="p-2">משתמש</th>
                <th className="p-2">פעולה</th>
                <th className="p-2">ישות</th>
                <th className="p-2">תקלה</th>
              </tr>
            </thead>
            <tbody>
              {(logs ?? []).map((l) => (
                <tr key={l.id} className="border-t border-hairline">
                  <td className="p-2 whitespace-nowrap">{formatDateTime(l.createdAt)}</td>
                  <td className="p-2">{name(l.actorId)}</td>
                  <td className="p-2">{l.action}</td>
                  <td className="p-2">{l.entityType}</td>
                  <td className="p-2">{l.incidentNumber ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const TABS = [
  { key: 'systems', label: 'מערכות / עמדות' },
  { key: 'locations', label: 'מיקומים' },
  { key: 'audit', label: 'יומן פעילות' },
] as const;

export default function AdminPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('systems');

  return (
    <div>
      <h1 className="page-title">ניהול</h1>
      <div role="tablist" aria-label="לשוניות ניהול" className="mt-3 flex flex-wrap gap-1 border-b border-hairline">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`min-h-11 rounded-t-lg px-3 py-2 text-sm font-medium ${
              tab === t.key
                ? 'border-b-2 border-brand-700 text-brand-700 dark:border-brand-400 dark:text-brand-400'
                : 'text-muted hover:text-text-primary'
            }`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-4">
        {tab === 'systems' && <ConfigTab kind="systems" />}
        {tab === 'locations' && <ConfigTab kind="locations" />}
        {tab === 'audit' && <AuditTab />}
      </div>
    </div>
  );
}
