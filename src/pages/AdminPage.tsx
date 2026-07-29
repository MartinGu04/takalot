// System administrator screen: systems/positions, locations, audit log.
// User/personnel management lives on the dedicated כוח אדם page (/personnel).
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useSession } from '../auth/AuthContext';
import { useProfiles, useSystems, useLocations, useAuditLogs, useAppMutation, repo } from '../data/hooks';
import { Badge, Button, Dialog, EmptyState, ErrorState, Field, Input, Spinner, useToast } from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FloatingPopover } from '../components/FloatingPopover';
import { IconChevronDown, IconTrash } from '../components/icons';
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

function MoveMenu({
  recordName,
  canMoveUp,
  canMoveDown,
  disabled,
  onMove,
}: {
  recordName: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  disabled: boolean;
  onMove: (direction: 'up' | 'down') => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<'first' | 'last'>('first');

  const menuItems = () =>
    Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );

  const openMenu = (focus: 'first' | 'last') => {
    focusOnOpen.current = focus;
    setOpen(true);
  };

  const closeAndFocusTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const selectDirection = (direction: 'up' | 'down') => {
    setOpen(false);
    triggerRef.current?.focus();
    onMove(direction);
  };

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const items = menuItems();
      const target = focusOnOpen.current === 'last' ? items.at(-1) : items[0];
      target?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAndFocusTrigger();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const focusAdjacentPageControl = (backwards: boolean) => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !panelRef.current?.contains(element));
    const currentIndex = controls.indexOf(trigger);
    controls[currentIndex + (backwards ? -1 : 1)]?.focus();
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      setOpen(false);
      focusAdjacentPageControl(event.shiftKey);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = menuItems();
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Home') {
      items[0].focus();
    } else if (event.key === 'End') {
      items.at(-1)?.focus();
    } else {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + step + items.length) % items.length;
      items[nextIndex].focus();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || (!canMoveUp && !canMoveDown)}
        aria-label={`שינוי סדר עבור ${recordName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => (open ? setOpen(false) : openMenu('first'))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu(event.key === 'ArrowUp' ? 'last' : 'first');
          }
        }}
        className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-hairline-strong bg-surface px-2.5 py-2 text-sm font-medium text-text-primary shadow-soft hover:bg-surface-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
      >
        שינוי סדר
        <IconChevronDown className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <FloatingPopover
        anchorRef={triggerRef}
        panelRef={panelRef}
        open={open}
        width={156}
        align="start"
        className="popover-panel z-50 animate-scale-in p-1.5"
      >
        <div
          id={menuId}
          role="menu"
          aria-label={`אפשרויות שינוי סדר עבור ${recordName}`}
          onKeyDown={handleMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={!canMoveUp || disabled}
            onClick={() => selectDirection('up')}
            className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-right text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span aria-hidden="true">↑</span>
            למעלה
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={!canMoveDown || disabled}
            onClick={() => selectDirection('down')}
            className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-right text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span aria-hidden="true">↓</span>
            למטה
          </button>
        </div>
      </FloatingPopover>
    </>
  );
}

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
        className="surface mb-4 grid grid-cols-1 items-start gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto]"
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
        <Button
          type="submit"
          className="sm:mt-[1.625rem]"
          disabled={!name.trim() || create.isPending}
        >
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

                <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 lg:justify-end">
                  <MoveMenu
                    recordName={record.name}
                    canMoveUp={index > 0}
                    canMoveDown={index < (data?.length ?? 0) - 1}
                    disabled={busy}
                    onMove={(direction) => move.mutate({ id: record.id, direction })}
                  />
                  <Button
                    variant="accent"
                    className="px-2.5!"
                    disabled={busy}
                    onClick={() => openRename(record)}
                  >
                    שינוי שם
                  </Button>
                  {record.archived ? (
                    <Button
                      variant="success"
                      className="px-2!"
                      disabled={busy}
                      onClick={() => setArchived.mutate({ id: record.id, archived: false })}
                    >
                      הפעלה מחדש
                    </Button>
                  ) : (
                    <Button
                      variant="warning"
                      className="px-2!"
                      disabled={busy}
                      onClick={() => setConfirming({ type: 'deactivate', record })}
                    >
                      השבתה
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    className="size-11 shrink-0 border border-transparent bg-transparent p-0! text-red-700! shadow-none hover:border-red-300! hover:bg-red-50! hover:text-red-800! focus-visible:border-red-300! focus-visible:bg-red-50! focus-visible:outline-red-600 dark:text-red-400! dark:hover:border-red-900! dark:hover:bg-red-950/40! dark:hover:text-red-300! dark:focus-visible:border-red-900! dark:focus-visible:bg-red-950/40! dark:focus-visible:outline-red-400"
                    disabled={busy}
                    aria-label={`מחיקת ${record.name}`}
                    title={`מחיקת ${record.name}`}
                    onClick={() => setConfirming({ type: 'delete', record })}
                  >
                    <IconTrash className="size-5" />
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
