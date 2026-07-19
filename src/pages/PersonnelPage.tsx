// כוח אדם -- who is authorized to enter Nexus and what role they have.
// Replaces the old technical "Users management" tab. Deliberately speaks
// only in personnel terms: no Supabase terminology, no UUIDs, no manual
// provisioning instructions. Source of truth: listPersonnel() (a unified
// view of live pending entries and linked profiles, mirrored identically
// in demo mode so this page is fully testable in CI without a real
// backend).
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../auth/AuthContext';
import { repo, useAppMutation } from '../data/hooks';
import { allowedPendingRoles } from '../domain/permissions';
import { personnelRoleLabels, personnelStatusLabels } from '../domain/labels';
import type { PersonnelEntry, Role } from '../domain/types';
import type { PendingPersonnelInput } from '../domain/schemas';
import { Badge, Button, EmptyState, ErrorState, Input, Select, Spinner } from '../components/ui';
import { PersonnelFormDialog } from '../components/dialogs/PersonnelFormDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { IconPlus } from '../components/icons';

type Tab = 'pending' | 'active' | 'inactive';

const TABS: { key: Tab; label: string }[] = [
  { key: 'pending', label: 'ממתינים להתחברות' },
  { key: 'active', label: 'פעילים' },
  { key: 'inactive', label: 'לא פעילים' },
];

function usePersonnel() {
  const session = useSession();
  return useQuery({ queryKey: ['personnel'], queryFn: () => repo().listPersonnel(session) });
}

export default function PersonnelPage() {
  const session = useSession();
  const { data, isLoading, isError, refetch } = usePersonnel();
  const [tab, setTab] = useState<Tab>('pending');
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<PersonnelEntry | null>(null);
  const [cancelingEntry, setCancelingEntry] = useState<PersonnelEntry | null>(null);
  const [deactivatingEntry, setDeactivatingEntry] = useState<PersonnelEntry | null>(null);
  const [roleChangeRequest, setRoleChangeRequest] = useState<{ entry: PersonnelEntry; newRole: Role } | null>(null);
  // Which linked row currently has its role/status controls expanded --
  // the controls are hidden by default so the list stays scannable with
  // many entries; only one row's controls are open at a time.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const allowedRoles = allowedPendingRoles(session.role);

  const createMutation = useAppMutation((input: PendingPersonnelInput) => repo().createPendingPersonnel(session, input), {
    invalidate: [['personnel']],
    successText:
      'איש הצוות נוסף וממתין להתחברות הראשונה עם חשבון Google שהוגדר. אין צורך בקישור מיוחד — יש להיכנס לכתובת הרגילה של Nexus.',
    onSuccess: () => setAddOpen(false),
  });

  const updateMutation = useAppMutation(
    (vars: { id: string; input: PendingPersonnelInput }) => repo().updatePendingPersonnel(session, vars.id, vars.input),
    {
      invalidate: [['personnel']],
      successText: 'הפרטים עודכנו.',
      onSuccess: () => setEditingEntry(null),
    },
  );

  const cancelMutation = useAppMutation((id: string) => repo().cancelPendingPersonnel(session, id), {
    invalidate: [['personnel']],
    successText: 'הרישום הממתין בוטל.',
    onSuccess: () => setCancelingEntry(null),
  });

  const activateMutation = useAppMutation((id: string) => repo().setUserActive(session, id, true), {
    invalidate: [['personnel'], ['profiles']],
    successText: 'המשתמש הופעל.',
    onSuccess: () => setExpandedId(null),
  });

  const deactivateMutation = useAppMutation((id: string) => repo().setUserActive(session, id, false), {
    invalidate: [['personnel'], ['profiles']],
    successText: 'המשתמש הושבת.',
    onSuccess: () => {
      setDeactivatingEntry(null);
      setExpandedId(null);
    },
  });

  const roleChangeMutation = useAppMutation(
    (vars: { id: string; role: Role }) => repo().setUserRole(session, vars.id, vars.role),
    {
      invalidate: [['personnel'], ['profiles']],
      successText: 'התפקיד עודכן.',
      onSuccess: () => {
        setRoleChangeRequest(null);
        setExpandedId(null);
      },
    },
  );

  const counts = useMemo(() => {
    const all = data ?? [];
    return {
      pending: all.filter((e) => e.kind === 'pending').length,
      active: all.filter((e) => e.kind === 'linked' && e.state === 'active').length,
      inactive: all.filter((e) => e.kind === 'linked' && e.state === 'inactive').length,
    };
  }, [data]);

  const activeAdminCount = useMemo(
    () => (data ?? []).filter((e) => e.kind === 'linked' && e.state === 'active' && e.role === 'system_admin').length,
    [data],
  );

  const rows = useMemo(() => {
    const all = data ?? [];
    const byTab = all.filter((e) => {
      if (tab === 'pending') return e.kind === 'pending';
      if (tab === 'active') return e.kind === 'linked' && e.state === 'active';
      return e.kind === 'linked' && e.state === 'inactive';
    });
    const q = search.trim().toLowerCase();
    if (!q) return byTab;
    return byTab.filter((e) => e.fullName.toLowerCase().includes(q) || (e.email ?? '').toLowerCase().includes(q));
  }, [data, tab, search]);

  if (isLoading) return <Spinner label="טוען כוח אדם…" />;
  if (isError) return <ErrorState message="שגיאה בטעינת כוח אדם." onRetry={() => refetch()} />;

  const emptyTitle = search.trim()
    ? 'לא נמצאו אנשי צוות התואמים לחיפוש.'
    : tab === 'pending'
      ? 'אין כרגע אנשי צוות שממתינים להתחברות.'
      : tab === 'active'
        ? 'עדיין אין אנשי צוות פעילים.'
        : 'אין אנשי צוות לא פעילים.';

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">כוח אדם</h1>
          <p className="mt-1 text-sm text-muted">מי מורשה להיכנס ל־Nexus ובאיזה תפקיד</p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <IconPlus className="size-4" />
          הוספת איש צוות
        </Button>
      </div>

      <div role="tablist" aria-label="סינון כוח אדם" className="mt-4 flex flex-wrap gap-1 border-b border-hairline">
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
            {t.label} ({counts[t.key]})
          </button>
        ))}
      </div>

      <div className="mt-3">
        <Input
          type="search"
          aria-label="חיפוש לפי שם או כתובת Google"
          placeholder="חיפוש לפי שם או כתובת Google…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {rows.length === 0 ? (
        <div className="mt-4">
          <EmptyState title={emptyTitle} />
        </div>
      ) : (
        <div className="surface mt-3 divide-y divide-hairline">
          {rows.map((entry) => {
            if (entry.kind === 'pending') {
              const canManage = allowedRoles.includes(entry.role);
              return (
                <div
                  key={entry.id}
                  data-personnel-row={entry.id}
                  className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">{entry.fullName}</p>
                    <p className="truncate text-xs text-muted" dir="ltr">
                      {entry.email}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <span className="text-sm text-text-secondary">{personnelRoleLabels[entry.role]}</span>
                    <Badge color="orange">{personnelStatusLabels.pending}</Badge>
                    {canManage && (
                      <>
                        <Button variant="ghost" className="px-2" onClick={() => setEditingEntry(entry)}>
                          עריכה
                        </Button>
                        <Button variant="ghost" className="px-2 text-red-700 dark:text-red-400" onClick={() => setCancelingEntry(entry)}>
                          ביטול
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            }

            const canManage = allowedRoles.includes(entry.role) && entry.id !== session.userId;
            const soleActiveAdmin = entry.role === 'system_admin' && entry.state === 'active' && activeAdminCount <= 1;
            const expanded = canManage && expandedId === entry.id;
            return (
              <div key={entry.id} data-personnel-row={entry.id} className="flex flex-col gap-2 px-3 py-2.5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">{entry.fullName}</p>
                    {entry.email && (
                      <p className="truncate text-xs text-muted" dir="ltr">
                        {entry.email}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <span className="text-sm text-text-secondary">{personnelRoleLabels[entry.role]}</span>
                    <Badge color={entry.state === 'active' ? 'green' : 'neutral'}>
                      {entry.state === 'active' ? personnelStatusLabels.active : personnelStatusLabels.inactive}
                    </Badge>
                    {entry.id === session.userId && <Badge color="blue">אתה</Badge>}
                    {canManage && (
                      <Button
                        variant="ghost"
                        className="px-2"
                        aria-expanded={expanded}
                        onClick={() => setExpandedId(expanded ? null : entry.id)}
                      >
                        עריכה
                      </Button>
                    )}
                  </div>
                </div>
                {expanded && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-active/60 p-2 sm:me-auto">
                    <Select
                      aria-label={`תפקיד ${entry.fullName}`}
                      className="w-auto"
                      value={entry.role}
                      disabled={soleActiveAdmin}
                      title={soleActiveAdmin ? 'לא ניתן לשנות את תפקיד מנהל המערכת הפעיל האחרון' : undefined}
                      onChange={(e) => {
                        const newRole = e.target.value as Role;
                        if (newRole !== entry.role) setRoleChangeRequest({ entry, newRole });
                      }}
                    >
                      {allowedRoles.map((r) => (
                        <option key={r} value={r}>
                          {personnelRoleLabels[r]}
                        </option>
                      ))}
                    </Select>
                    {entry.state === 'active' ? (
                      <Button
                        variant="secondary"
                        disabled={soleActiveAdmin}
                        title={soleActiveAdmin ? 'לא ניתן להשבית את מנהל המערכת הפעיל האחרון' : undefined}
                        onClick={() => setDeactivatingEntry(entry)}
                      >
                        השבתה
                      </Button>
                    ) : (
                      <Button variant="secondary" onClick={() => activateMutation.mutate(entry.id)}>
                        הפעלה
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <PersonnelFormDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="הוספת איש צוות"
        submitLabel="הוספה"
        allowedRoles={allowedRoles}
        onSubmit={(input) => createMutation.mutate(input)}
        submitting={createMutation.isPending}
      />

      {editingEntry && (
        <PersonnelFormDialog
          open
          onClose={() => setEditingEntry(null)}
          title="עריכת רישום ממתין"
          submitLabel="שמירה"
          allowedRoles={allowedRoles}
          initial={{ fullName: editingEntry.fullName, email: editingEntry.email ?? '', role: editingEntry.role }}
          onSubmit={(input) => updateMutation.mutate({ id: editingEntry.id, input })}
          submitting={updateMutation.isPending}
        />
      )}

      <ConfirmDialog
        open={!!cancelingEntry}
        onClose={() => setCancelingEntry(null)}
        title="ביטול רישום ממתין"
        message={`לבטל את הרישום הממתין של ${cancelingEntry?.fullName ?? ''}? לא ניתן יהיה להתחבר עם הכתובת הזו עד שייווצר רישום חדש.`}
        confirmLabel="ביטול הרישום"
        danger
        submitting={cancelMutation.isPending}
        onConfirm={() => cancelingEntry && cancelMutation.mutate(cancelingEntry.id)}
      />

      <ConfirmDialog
        open={!!deactivatingEntry}
        onClose={() => setDeactivatingEntry(null)}
        title="השבתת משתמש"
        message={`להשבית את ${deactivatingEntry?.fullName ?? ''}? לא ניתן יהיה להתחבר ל-Nexus עד להפעלה מחדש.`}
        confirmLabel="השבתה"
        danger
        submitting={deactivateMutation.isPending}
        onConfirm={() => deactivatingEntry && deactivateMutation.mutate(deactivatingEntry.id)}
      />

      <ConfirmDialog
        open={!!roleChangeRequest}
        onClose={() => setRoleChangeRequest(null)}
        title="שינוי תפקיד"
        message={
          roleChangeRequest
            ? `לשנות את התפקיד של ${roleChangeRequest.entry.fullName} ל"${personnelRoleLabels[roleChangeRequest.newRole]}"?`
            : ''
        }
        confirmLabel="שינוי תפקיד"
        submitting={roleChangeMutation.isPending}
        onConfirm={() =>
          roleChangeRequest && roleChangeMutation.mutate({ id: roleChangeRequest.entry.id, role: roleChangeRequest.newRole })
        }
      />
    </div>
  );
}
