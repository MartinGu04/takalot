// System administrator screen: users, systems/positions, locations, audit log.
import { useState } from 'react';
import { useSession } from '../auth/AuthContext';
import { isDemoMode } from '../data';
import { useProfiles, useSystems, useLocations, useAuditLogs, useAppMutation, repo } from '../data/hooks';
import { roleLabels } from '../domain/labels';
import type { Role } from '../domain/types';
import { Button, Field, Input, Select, Spinner, EmptyState } from '../components/ui';
import { formatDateTime } from '../lib/time';

const ROLES: Role[] = ['system_admin', 'professional_manager', 'shift_supervisor', 'technician', 'viewer'];

function UsersTab() {
  const session = useSession();
  const demo = isDemoMode();
  const { data: profiles, isLoading } = useProfiles();
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<Role>('technician');

  const createUser = useAppMutation((vars: { name: string; role: Role }) => repo().createUser(session, vars.name, vars.role), {
    successText: 'המשתמש נוצר.',
    invalidate: [['profiles']],
    onSuccess: () => setNewName(''),
  });
  const setRole = useAppMutation((vars: { id: string; role: Role }) => repo().setUserRole(session, vars.id, vars.role), {
    successText: 'התפקיד עודכן.',
    invalidate: [['profiles']],
  });
  const setActive = useAppMutation((vars: { id: string; active: boolean }) => repo().setUserActive(session, vars.id, vars.active), {
    successText: 'הסטטוס עודכן.',
    invalidate: [['profiles']],
  });

  if (isLoading) return <Spinner />;

  return (
    <div>
      {demo ? (
        // Demo-only fictional-user creation. In supabase mode this action is
        // absent entirely: it would only write a disconnected placeholder
        // row, which neither creates nor authorizes a real Google user, so
        // presenting it as "user creation" there would be misleading.
        <div className="mb-4 flex flex-wrap items-end gap-2 surface p-3">
          <Field label="שם מלא (משתמש הדגמה)">
            {(a) => <Input {...a} value={newName} onChange={(e) => setNewName(e.target.value)} />}
          </Field>
          <Field label="תפקיד">
            {(a) => (
              <Select {...a} value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>{roleLabels[r]}</option>
                ))}
              </Select>
            )}
          </Field>
          <Button
            disabled={!newName.trim() || createUser.isPending}
            onClick={() => createUser.mutate({ name: newName.trim(), role: newRole })}
          >
            הוספת משתמש
          </Button>
        </div>
      ) : (
        <div
          className="mb-4 surface p-3 text-sm text-secondary"
          data-testid="user-provisioning-note"
        >
          <p className="font-medium text-text-primary">הוספת משתמש חדש</p>
          <p className="mt-1">
            משתמש חדש מתחבר תחילה עם Google (ויקבל מסך "אין הרשאת גישה"), ולאחר מכן מנהל המערכת
            מסדיר עבורו פרופיל פעיל דרך ממשק הניהול של Supabase. לא ניתן ליצור משתמש מורשה מתוך
            מסך זה. משתמשים שכבר הוסדרו מנוהלים כאן — תפקיד והפעלה/השבתה.
          </p>
        </div>
      )}
      <div className="flex flex-col gap-2">
        {(profiles ?? []).map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-2 surface p-3">
            <span className="font-medium">{p.fullName}</span>
            <Select
              className="w-auto"
              aria-label={`תפקיד ${p.fullName}`}
              value={p.role}
              onChange={(e) => setRole.mutate({ id: p.id, role: e.target.value as Role })}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{roleLabels[r]}</option>
              ))}
            </Select>
            <label className="ms-auto flex items-center gap-2 text-sm">
              <input type="checkbox" checked={p.active} onChange={(e) => setActive.mutate({ id: p.id, active: e.target.checked })} />
              פעיל
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfigTab({ kind }: { kind: 'systems' | 'locations' }) {
  const session = useSession();
  const systemsQ = useSystems();
  const locationsQ = useLocations();
  const data = kind === 'systems' ? systemsQ.data : locationsQ.data;
  const [name, setName] = useState('');

  const create = useAppMutation(
    (n: string) => (kind === 'systems' ? repo().createSystem(session, n) : repo().createLocation(session, n)),
    { successText: 'נוצר בהצלחה.', invalidate: [['systems'], ['locations']], onSuccess: () => setName('') },
  );
  const setArchived = useAppMutation(
    (vars: { id: string; archived: boolean }) =>
      kind === 'systems'
        ? repo().setSystemArchived(session, vars.id, vars.archived)
        : repo().setLocationArchived(session, vars.id, vars.archived),
    { successText: 'העדכון נשמר.', invalidate: [['systems'], ['locations']] },
  );

  return (
    <div>
      <div className="mb-4 flex items-end gap-2 surface p-3">
        <Field label={kind === 'systems' ? 'שם מערכת / עמדה חדשה' : 'שם מיקום חדש'}>
          {(a) => <Input {...a} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate(name.trim())}>
          הוספה
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        {(data ?? []).map((r) => (
          <div key={r.id} className="flex items-center gap-2 surface p-3">
            <span className={r.archived ? 'text-muted line-through' : 'font-medium'}>{r.name}</span>
            <Button
              variant="secondary"
              className="ms-auto"
              onClick={() => setArchived.mutate({ id: r.id, archived: !r.archived })}
            >
              {r.archived ? 'שחזור' : 'העברה לארכיון'}
            </Button>
          </div>
        ))}
      </div>
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
  { key: 'users', label: 'משתמשים' },
  { key: 'systems', label: 'מערכות / עמדות' },
  { key: 'locations', label: 'מיקומים' },
  { key: 'audit', label: 'יומן פעילות' },
] as const;

export default function AdminPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('users');

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
        {tab === 'users' && <UsersTab />}
        {tab === 'systems' && <ConfigTab kind="systems" />}
        {tab === 'locations' && <ConfigTab kind="locations" />}
        {tab === 'audit' && <AuditTab />}
      </div>
    </div>
  );
}
