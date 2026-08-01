// System administrator screen: systems/positions, locations, audit log.
// User/personnel management lives on the dedicated כוח אדם page (/personnel).
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useSession } from '../auth/AuthContext';
import { useProfiles, useSystems, useLocations, useAuditLogs, useAppMutation, repo } from '../data/hooks';
import { hasCapability } from '../domain/permissions';
import { Badge, Button, Dialog, EmptyState, ErrorState, Field, Input, Spinner, useToast } from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { IconTrash } from '../components/icons';
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

const DRAG_SCREEN_READER_INSTRUCTIONS = {
  draggable:
    'לחצו על מקש הרווח כדי להתחיל בגרירה של הפריט. השתמשו בחצים למעלה ולמטה כדי להעביר את הפריט למיקום אחר ברשימה, לחצו שוב על הרווח כדי לשמור את המיקום החדש, או על מקש Escape כדי לבטל את הגרירה ולחזור למיקום הקודם.',
};

function usePrefersReducedMotion(): boolean {
  return useMemo(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);
}

function DragHandle({
  recordName,
  disabled,
  attributes,
  listeners,
}: {
  recordName: string;
  disabled: boolean;
  attributes: ReturnType<typeof useSortable>['attributes'];
  listeners: ReturnType<typeof useSortable>['listeners'];
}) {
  return (
    <button
      type="button"
      {...attributes}
      {...listeners}
      disabled={disabled}
      aria-label={`גרירה לשינוי סדר עבור ${recordName}`}
      title="גרירה לשינוי סדר"
      className="inline-flex min-h-11 w-11 shrink-0 touch-none items-center justify-center self-start rounded-lg border border-hairline-strong bg-surface text-lg leading-none text-text-secondary shadow-soft hover:bg-surface-hover active:cursor-grabbing lg:self-center disabled:cursor-not-allowed disabled:opacity-40"
      style={{ cursor: disabled ? undefined : 'grab' }}
    >
      <span aria-hidden="true">⠿</span>
    </button>
  );
}

function ConfigRow({
  record,
  canReorder,
  busy,
  onOpenRename,
  onReactivate,
  onDeactivateRequest,
  onDeleteRequest,
}: {
  record: ConfigRecord;
  canReorder: boolean;
  busy: boolean;
  onOpenRename: () => void;
  onReactivate: () => void;
  onDeactivateRequest: () => void;
  onDeleteRequest: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: record.id,
    disabled: !canReorder || busy,
  });
  const prefersReducedMotion = usePrefersReducedMotion();

  return (
    <article
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: prefersReducedMotion ? undefined : transition,
      }}
      className={`surface p-4 ${isDragging ? 'relative z-10 shadow-lg ring-2 ring-brand-500 dark:ring-brand-400' : ''}`}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        {canReorder && (
          <DragHandle
            recordName={record.name}
            disabled={busy}
            attributes={attributes}
            listeners={listeners}
          />
        )}
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
          <Button variant="accent" className="px-2.5!" disabled={busy} onClick={onOpenRename}>
            שינוי שם
          </Button>
          {record.archived ? (
            <Button variant="success" className="px-2!" disabled={busy} onClick={onReactivate}>
              הפעלה מחדש
            </Button>
          ) : (
            <Button variant="warning" className="px-2!" disabled={busy} onClick={onDeactivateRequest}>
              השבתה
            </Button>
          )}
          <Button
            variant="ghost"
            className="size-11 shrink-0 border border-transparent bg-transparent p-0! text-red-700! shadow-none hover:border-red-300! hover:bg-red-50! hover:text-red-800! focus-visible:border-red-300! focus-visible:bg-red-50! focus-visible:outline-red-600 dark:text-red-400! dark:hover:border-red-900! dark:hover:bg-red-950/40! dark:hover:text-red-300! dark:focus-visible:border-red-900! dark:focus-visible:bg-red-950/40! dark:focus-visible:outline-red-400"
            disabled={busy}
            aria-label={`מחיקת ${record.name}`}
            title={`מחיקת ${record.name}`}
            onClick={onDeleteRequest}
          >
            <IconTrash className="size-5" />
          </Button>
        </div>
      </div>
    </article>
  );
}

function ConfigTab({ kind }: { kind: ConfigKind }) {
  const session = useSession();
  const canReorder = hasCapability(session.role, 'manage_config');
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
  const [orderedRecords, setOrderedRecords] = useState<ConfigRecord[]>([]);
  const previousOrderRef = useRef<ConfigRecord[]>([]);

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
  const reorder = useAppMutation(
    (orderedIds: string[]) =>
      kind === 'systems'
        ? repo().reorderSystems(session, orderedIds)
        : repo().reorderLocations(session, orderedIds),
    {
      invalidate: [[kind]],
      onError: (error) => {
        setOrderedRecords(previousOrderRef.current);
        toast(error.message, 'error');
      },
    },
  );

  useEffect(() => {
    if (reorder.isPending) return;
    setOrderedRecords(data ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, reorder.isPending]);

  const busy =
    create.isPending || rename.isPending || setArchived.isPending || remove.isPending || reorder.isPending;

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && !create.isPending) create.mutate(name);
  };

  const openRename = (record: ConfigRecord) => {
    setRenaming(record);
    setRenameValue(record.name);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const recordName = (id: string) => orderedRecords.find((record) => record.id === String(id))?.name ?? '';

  const announcements: Announcements = {
    onDragStart({ active }) {
      return `הוחל בגרירת ${recordName(String(active.id))}.`;
    },
    onDragOver({ active, over }) {
      if (!over) return `${recordName(String(active.id))} אינו ממוקם מעל פריט אחר כרגע.`;
      if (over.id === active.id) return `${recordName(String(active.id))} חזר למיקומו המקורי.`;
      return `${recordName(String(active.id))} ממוקם כעת במקום ${recordName(String(over.id))}.`;
    },
    onDragEnd({ active, over }) {
      if (!over || over.id === active.id) return `הגרירה של ${recordName(String(active.id))} בוטלה.`;
      return `הסדר עודכן: ${recordName(String(active.id))} הועבר למיקום חדש.`;
    },
    onDragCancel({ active }) {
      return `הגרירה של ${recordName(String(active.id))} בוטלה, הסדר הקודם נשמר.`;
    },
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if (reorder.isPending) return;
    const oldIndex = orderedRecords.findIndex((record) => record.id === active.id);
    const newIndex = orderedRecords.findIndex((record) => record.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    previousOrderRef.current = orderedRecords;
    const next = arrayMove(orderedRecords, oldIndex, newIndex);
    setOrderedRecords(next);
    reorder.mutate(next.map((record) => record.id));
  };

  const rows = (): ReactNode => {
    const items = orderedRecords;
    if (items.length === 0) return null;
    return items.map((record) => (
      <ConfigRow
        key={record.id}
        record={record}
        canReorder={canReorder}
        busy={busy}
        onOpenRename={() => openRename(record)}
        onReactivate={() => setArchived.mutate({ id: record.id, archived: false })}
        onDeactivateRequest={() => setConfirming({ type: 'deactivate', record })}
        onDeleteRequest={() => setConfirming({ type: 'delete', record })}
      />
    ));
  };

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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          accessibility={{ announcements, screenReaderInstructions: DRAG_SCREEN_READER_INSTRUCTIONS }}
        >
          <SortableContext
            items={orderedRecords.map((record) => record.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-3" aria-label={`רשימת ${copy.plural}`}>
              {rows()}
            </div>
          </SortableContext>
        </DndContext>
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
