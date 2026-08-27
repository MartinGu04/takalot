// כוח אדם -- who is authorized to enter Nexus and what role they have.
// Replaces the old technical "Users management" tab. Deliberately speaks
// only in personnel terms: no Supabase terminology, no UUIDs, no manual
// provisioning instructions. Source of truth: listPersonnel() (a unified
// view of live pending entries and linked profiles, mirrored identically
// in demo mode so this page is fully testable in CI without a real
// backend).
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../auth/AuthContext';
import { repo, useAppMutation } from '../data/hooks';
import { allowedAssignRoles, allowedManageRoles } from '../domain/permissions';
import { personnelRoleLabels, personnelStatusLabels } from '../domain/labels';
import type { InvitationSendOutcome, PersonnelEntry, Role } from '../domain/types';
import type { PendingPersonnelInput } from '../domain/schemas';
import { Avatar, Badge, Button, EmptyState, ErrorState, Input, Select, Spinner, useToast } from '../components/ui';
import { PersonnelFormDialog } from '../components/dialogs/PersonnelFormDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DeleteUserDialog } from '../components/dialogs/DeleteUserDialog';
import { RenamePersonnelDialog } from '../components/dialogs/RenamePersonnelDialog';
import { ActionMenu } from '../components/ActionMenu';
import { IconPlus } from '../components/icons';

type Tab = 'pending' | 'active' | 'inactive';

const TABS: { key: Tab; label: string }[] = [
  { key: 'pending', label: 'ממתינים להתחברות' },
  { key: 'active', label: 'פעילים' },
  { key: 'inactive', label: 'לא פעילים' },
];

/**
 * Display order for the role groups below, highest authority first. This
 * mirrors the role hierarchy the system already implements -- the strict
 * (non-peer) ceilings in allowedAssignRoles/allowedManageRoles and their
 * database counterparts role_ceiling_allows_assign/role_ceiling_allows_manage
 * -- but it is presentation only: grouping changes nothing about who may
 * manage whom, which stays entirely with those ceilings.
 */
const ROLE_GROUP_ORDER: Role[] = [
  'system_admin',
  'professional_manager',
  'shift_supervisor',
  'technician',
  'viewer',
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
  const [deletingEntry, setDeletingEntry] = useState<PersonnelEntry | null>(null);
  const [renamingEntry, setRenamingEntry] = useState<PersonnelEntry | null>(null);
  const [recoveringEntry, setRecoveringEntry] = useState<PersonnelEntry | null>(null);
  const [roleChangeRequest, setRoleChangeRequest] = useState<{ entry: PersonnelEntry; newRole: Role } | null>(null);
  // Which linked row currently has its role/status controls expanded --
  // the controls are hidden by default so the list stays scannable with
  // many entries; only one row's controls are open at a time.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Deliberately separate: who this session may ASSIGN a role to when
  // registering a new pending entry, vs. whose ALREADY-LINKED role/status
  // they may edit -- mirrors the database's two separate ceiling
  // functions (role_ceiling_allows_assign / role_ceiling_allows_manage).
  const assignRoles = allowedAssignRoles(session.role);
  const manageRoles = allowedManageRoles(session.role);
  // A non-empty manageRoles ceiling exists only for the three
  // personnel-manager roles (shift_supervisor / professional_manager /
  // system_admin) -- used for the self-service rename carve-out below,
  // which is deliberately independent of manageRoles.includes(entry.role)
  // (that ceiling excludes a caller's own peer rank).
  const isPersonnelManager = manageRoles.length > 0;

  const queryClient = useQueryClient();
  const toast = useToast();

  // Sending the invitation is chained INSIDE this one mutationFn -- a
  // single explicit, user-triggered submit -- rather than as a second,
  // separately-fired call from onSuccess: React Query only ever invokes a
  // mutationFn once per mutate() call (never on rerenders or cache
  // refetches), so this can never double-send an invitation the way a
  // render-triggered effect could. A failed SEND never rolls back the
  // already-created person: sendPersonnelInvitation reports a failed send
  // as data ({outcome:'failed'}), and even a thrown request-level failure
  // (network, unauthorized) is caught here and folded into the same shape
  // -- createPendingPersonnel having already resolved is what matters for
  // "was the person created", never the invitation's own outcome.
  const createMutation = useAppMutation(
    async (input: PendingPersonnelInput) => {
      const entry = await repo().createPendingPersonnel(session, input);
      let invitation: InvitationSendOutcome;
      try {
        invitation = await repo().sendPersonnelInvitation(session, entry.id);
      } catch {
        invitation = { outcome: 'failed' };
      }
      return { entry, invitation };
    },
    {
      invalidate: [['personnel']],
      onSuccess: ({ entry, invitation }) => {
        toast(
          invitation.outcome === 'sent'
            ? `המשתמש נוסף בהצלחה והזמנה נשלחה ל-${entry.email}`
            : 'המשתמש נוסף בהצלחה, אך שליחת ההזמנה נכשלה. ניתן לשלוח שוב מתוך התפריט של הרישום.',
          invitation.outcome === 'sent' ? 'success' : 'error',
        );
        setAddOpen(false);
      },
    },
  );

  const resendInvitationMutation = useAppMutation(
    (id: string) => repo().sendPersonnelInvitation(session, id),
    {
      invalidate: [['personnel']],
      onSuccess: (outcome) => {
        toast(
          outcome.outcome === 'sent' ? 'ההזמנה נשלחה מחדש.' : 'שליחת ההזמנה נכשלה. ניתן לנסות שוב.',
          outcome.outcome === 'sent' ? 'success' : 'error',
        );
      },
    },
  );

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

  const renameMutation = useAppMutation(
    async (vars: { entry: PersonnelEntry; fullName: string }): Promise<void> => {
      if (vars.entry.kind === 'pending') {
        await repo().renamePendingPersonnel(session, vars.entry.id, { fullName: vars.fullName });
      } else {
        await repo().renameLinkedPersonnel(session, vars.entry.id, { fullName: vars.fullName });
      }
    },
    {
      invalidate: [['personnel'], ['profiles']],
      successText: 'השם עודכן.',
      onSuccess: () => setRenamingEntry(null),
    },
  );

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

  const deleteMutation = useAppMutation((id: string) => repo().deleteUser(session, id), {
    invalidate: [['personnel'], ['profiles']],
    successText: 'המשתמש נמחק לצמיתות. חשבון ההתחברות הוסר.',
    onSuccess: () => {
      setDeletingEntry(null);
      setExpandedId(null);
    },
    onError: (error) => {
      // DELETE_INCOMPLETE means the database half already succeeded (the
      // profile IS deactivated and tombstoned) -- only the Auth-account
      // deletion failed and needs a retry. Refresh personnel data so the
      // list reflects that, in addition to explaining what to do next.
      if (error.code === 'DELETE_INCOMPLETE') {
        queryClient.invalidateQueries({ queryKey: ['personnel'] });
        queryClient.invalidateQueries({ queryKey: ['profiles'] });
        setDeletingEntry(null);
        setExpandedId(null);
      }
      toast(error.message, 'error');
    },
  });

  // Recovery-only action for an already-tombstoned profile: calls the
  // SAME repo().deleteUser() -- the RPC no-ops on the (already
  // authorized) already-deleted profile and only retries/verifies the
  // Auth-account removal. No new backend call, no re-deletion of the
  // Nexus profile.
  const retryAuthDeleteMutation = useAppMutation((id: string) => repo().deleteUser(session, id), {
    invalidate: [['personnel'], ['profiles']],
    successText: 'חשבון ההתחברות אומת כמוסר (או שכבר לא היה קיים).',
    onSuccess: () => setRecoveringEntry(null),
    onError: (error) => {
      // A repeat DELETE_INCOMPLETE here means the same genuine Auth
      // failure persists -- keep the dialog open so it can be retried
      // again, same as any other error.
      toast(error.message, 'error');
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
      // Deleted (tombstoned) profiles have no live login access, same as
      // deactivated ones -- shown under the existing "לא פעילים" tab
      // rather than a new filter/tab, distinguished by the נמחק badge.
      inactive: all.filter((e) => e.kind === 'linked' && (e.state === 'inactive' || e.state === 'deleted')).length,
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
      return e.kind === 'linked' && (e.state === 'inactive' || e.state === 'deleted');
    });
    const q = search.trim().toLowerCase();
    if (!q) return byTab;
    return byTab.filter((e) => e.fullName.toLowerCase().includes(q) || (e.email ?? '').toLowerCase().includes(q));
  }, [data, tab, search]);

  // Grouping is applied to `rows` -- i.e. AFTER the active tab and the search
  // query have already selected the result set -- so it only ever reorganizes
  // what the user can currently see. Groups with no members in that set are
  // omitted entirely rather than rendered empty.
  const groups = useMemo(
    () =>
      ROLE_GROUP_ORDER.map((role) => ({ role, entries: rows.filter((e) => e.role === role) })).filter(
        (group) => group.entries.length > 0,
      ),
    [rows],
  );

  if (isLoading) return <Spinner label="טוען כוח אדם…" />;
  if (isError) return <ErrorState message="שגיאה בטעינת כוח אדם." onRetry={() => refetch()} />;

  // Row rendering is shared by every role group. Both branches keep their
  // existing eligibility rules verbatim -- only the presentation of the
  // edit/delete controls changed (visible buttons -> one overflow menu).
  function renderRow(entry: PersonnelEntry) {
    if (entry.kind === 'pending') {
      const canManage = assignRoles.includes(entry.role);
      // Same visual hierarchy as an active/inactive row (avatar + name/email
      // block on the right, status/menu on the left) -- see the comment on
      // that row below for the RTL source-order reasoning. No inline role
      // label here: a pending row already sits under its role's group
      // heading, so repeating the role on every row would be redundant.
      // entry.avatarUrl is always null before first login (see
      // domain/types.ts), so this renders the same initials fallback the
      // active/inactive row would show for someone with no photo yet --
      // never a Google avatar for an unclaimed entry.
      return (
        <div key={entry.id} data-personnel-row={entry.id} className="flex items-center gap-3 px-3 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Avatar
              aria-hidden
              src={entry.avatarUrl}
              name={entry.fullName}
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-800 dark:bg-brand-950 dark:text-brand-200"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text-primary">{entry.fullName}</p>
              {entry.email && (
                <p className="truncate text-right text-xs text-muted" dir="ltr">
                  {entry.email}
                </p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Badge color="orange">{personnelStatusLabels.pending}</Badge>
            {entry.invitationStatus === 'failed' && <Badge color="red">שליחת ההזמנה נכשלה</Badge>}
            {entry.invitationStatus === 'sent' && <Badge color="green">הוזמן</Badge>}
            {canManage && (
              <ActionMenu
                label={`פעולות עבור ${entry.fullName}`}
                items={[
                  { label: 'עריכה', onSelect: () => setEditingEntry(entry) },
                  {
                    label: resendInvitationMutation.isPending ? 'שולח…' : 'שליחת הזמנה מחדש',
                    disabled: resendInvitationMutation.isPending,
                    onSelect: () => resendInvitationMutation.mutate(entry.id),
                  },
                  { label: 'שינוי שם', onSelect: () => setRenamingEntry(entry) },
                  // A pending entry is cancelled, not deleted -- it has no
                  // account to remove yet. The label stays "ביטול" so the
                  // action keeps meaning exactly what it always did.
                  { label: 'ביטול', destructive: true, onSelect: () => setCancelingEntry(entry) },
                ]}
              />
            )}
          </div>
        </div>
      );
    }

    const isSelf = entry.id === session.userId;
    // A tombstoned profile is permanent history, not manageable
    // personnel: no עריכה toggle, no role/active controls, and no
    // repeated delete action -- the frontend just doesn't offer
    // them (the database rejects all three regardless).
    const canManageOthers = manageRoles.includes(entry.role) && !isSelf && entry.state !== 'deleted';
    // Self-service rename only: the same three personnel-manager roles
    // that may manage OTHER people's records (isPersonnelManager, derived
    // from allowedManageRoles being non-empty for this session) may
    // rename THEMSELVES -- deliberately not gated by manageRoles.includes
    // (that ceiling excludes a caller's own peer rank and would wrongly
    // block e.g. a professional_manager from renaming themselves). Every
    // other self-service control (role, activation, deletion) stays
    // unavailable, matching the backend exactly.
    const canRenameSelf = isSelf && isPersonnelManager && entry.state !== 'deleted';
    // Recovery-only: the SAME role-ceiling/self exclusion as
    // canManageOthers, but for an already-tombstoned profile -- offers
    // nothing except retrying/verifying Auth-account removal
    // (never role, activation, edit, or repeated deletion).
    const canRecoverAuth = manageRoles.includes(entry.role) && !isSelf && entry.state === 'deleted';
    const soleActiveAdmin = entry.role === 'system_admin' && entry.state === 'active' && activeAdminCount <= 1;
    const expanded = canManageOthers && expandedId === entry.id;
    return (
      <div key={entry.id} data-personnel-row={entry.id} className="flex flex-col gap-2 px-3 py-2.5">
        <div className="flex items-center gap-3">
          {/* RTL: first in source order sits rightmost -- the avatar sits
              at the row's start (right), immediately before the name/email
              block, which stays first overall so the status/menu group
              below reads as the row's end (left). The email keeps dir="ltr"
              for correct character ordering but is explicitly text-right so
              it stays pinned under the name instead of hugging the left
              edge of this (often much wider) flex-1 box. */}
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Avatar
              aria-hidden
              src={entry.avatarUrl}
              name={entry.fullName}
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-800 dark:bg-brand-950 dark:text-brand-200"
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <p className="min-w-0 truncate text-sm font-medium text-text-primary">{entry.fullName}</p>
                {isSelf && <Badge color="blue">אתה</Badge>}
              </div>
              {entry.email && (
                <p className="truncate text-right text-xs text-muted" dir="ltr">
                  {entry.email}
                </p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Badge color={entry.state === 'active' ? 'green' : entry.state === 'deleted' ? 'red' : 'neutral'}>
              {personnelStatusLabels[entry.state]}
            </Badge>
            {(canManageOthers || canRenameSelf) && (
              <ActionMenu
                label={`פעולות עבור ${entry.fullName}`}
                items={[
                  ...(canManageOthers
                    ? [{ label: 'עריכה', onSelect: () => setExpandedId(expanded ? null : entry.id) }]
                    : []),
                  { label: 'שינוי שם', onSelect: () => setRenamingEntry(entry) },
                  ...(canManageOthers
                    ? [
                        {
                          label: 'מחיקה',
                          destructive: true,
                          disabled: soleActiveAdmin,
                          title: soleActiveAdmin ? 'לא ניתן למחוק את מנהל המערכת הפעיל האחרון' : undefined,
                          onSelect: () => setDeletingEntry(entry),
                        },
                      ]
                    : []),
                ]}
              />
            )}
            {canRecoverAuth && (
              <Button variant="ghost" className="px-2" onClick={() => setRecoveringEntry(entry)}>
                ווידוא הסרת חשבון ההתחברות
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
              {manageRoles.map((r) => (
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
  }

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
          <p className="mt-1 text-sm text-muted">מי מורשה להיכנס ל־AVARIA ובאיזה תפקיד</p>
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
        <div className="mt-3 flex flex-col gap-4">
          {groups.map((group) => (
            <section key={group.role} aria-labelledby={`personnel-group-${group.role}`}>
              <h2
                id={`personnel-group-${group.role}`}
                className="px-1 text-xs font-bold tracking-wide text-muted uppercase"
              >
                {personnelRoleLabels[group.role]} ({group.entries.length})
              </h2>
              <div className="surface mt-1.5 divide-y divide-hairline">
                {group.entries.map((entry) => renderRow(entry))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Mounted only while open -- the same treatment the edit dialog below
          already gets. Closing (whether by cancelling or by a CONFIRMED
          successful creation, which is the only thing that clears addOpen)
          unmounts the form, so the next opening starts from clean defaults
          instead of the previously created person's details. A FAILED
          creation leaves addOpen true, so the dialog stays mounted and every
          entered value is preserved. */}
      {addOpen && (
        <PersonnelFormDialog
          open
          onClose={() => setAddOpen(false)}
          title="הוספת איש צוות"
          submitLabel="הוספה"
          allowedRoles={assignRoles}
          onSubmit={(input) => createMutation.mutate(input)}
          submitting={createMutation.isPending}
        />
      )}

      {editingEntry && (
        <PersonnelFormDialog
          open
          onClose={() => setEditingEntry(null)}
          title="עריכת רישום ממתין"
          submitLabel="שמירה"
          allowedRoles={assignRoles}
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
        message={`להשבית את ${deactivatingEntry?.fullName ?? ''}? לא ניתן יהיה להתחבר ל-AVARIA עד להפעלה מחדש.`}
        confirmLabel="השבתה"
        danger
        submitting={deactivateMutation.isPending}
        onConfirm={() => deactivatingEntry && deactivateMutation.mutate(deactivatingEntry.id)}
      />

      <DeleteUserDialog
        entry={deletingEntry}
        onClose={() => setDeletingEntry(null)}
        submitting={deleteMutation.isPending}
        onConfirm={() => deletingEntry && deleteMutation.mutate(deletingEntry.id)}
      />

      {renamingEntry && (
        <RenamePersonnelDialog
          open
          currentName={renamingEntry.fullName}
          onClose={() => setRenamingEntry(null)}
          submitting={renameMutation.isPending}
          onSubmit={(fullName) => renameMutation.mutate({ entry: renamingEntry, fullName })}
        />
      )}

      <ConfirmDialog
        open={!!recoveringEntry}
        onClose={() => setRecoveringEntry(null)}
        title="ווידוא הסרת חשבון ההתחברות"
        message={`הפרופיל של ${recoveringEntry?.fullName ?? ''} ב-AVARIA כבר נמחק לצמיתות ומושבת -- פעולה זו אינה מוחקת אותו מחדש. היא רק מנסה שוב לוודא שחשבון ההתחברות שלו הוסר מ-Supabase Auth.`}
        confirmLabel="ניסיון חוזר"
        submitting={retryAuthDeleteMutation.isPending}
        onConfirm={() => recoveringEntry && retryAuthDeleteMutation.mutate(recoveringEntry.id)}
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
