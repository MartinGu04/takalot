// System administrator screen: systems/positions, locations, audit log.
// User/personnel management lives on the dedicated כוח אדם page (/personnel).
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
import { LOCATION_CATEGORY_ORDER, SYSTEM_CATEGORY_ORDER, locationCategoryLabels, systemCategoryLabels } from '../domain/labels';
import { Badge, Button, Dialog, EmptyState, ErrorState, Field, Input, Select, Spinner, useToast } from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ChangeCategoryDialog } from '../components/dialogs/ChangeCategoryDialog';
import { ActionMenu, type ActionMenuItem } from '../components/ActionMenu';
import { IconGripVertical } from '../components/icons';
import type { LocationCategory, LocationRecord, SystemCategory, SystemRecord } from '../domain/types';
import { formatDateTime } from '../lib/time';

type ConfigKind = 'systems' | 'locations';
type ConfigRecord = SystemRecord | LocationRecord;

const CONFIG_COPY = {
  systems: {
    singular: 'מערכת / עמדה',
    plural: 'מערכות / עמדות',
    createLabel: 'שם מערכת / עמדה חדשה',
    created: 'המערכת / העמדה נוספה בהצלחה.',
    deleted: 'המערכת / העמדה נמחקה לצמיתות משום שלא הייתה בשימוש.',
    archivedByDelete: 'המערכת / העמדה נמצאת בשימוש ולכן הועברה למצב לא פעיל ולא נמחקה.',
    searchLabel: 'חיפוש במערכות / עמדות',
  },
  locations: {
    singular: 'מיקום',
    plural: 'מיקומים',
    createLabel: 'שם מיקום חדש',
    created: 'המיקום נוסף בהצלחה.',
    deleted: 'המיקום נמחק לצמיתות משום שלא היה בשימוש.',
    archivedByDelete: 'המיקום נמצא בשימוש ולכן הועבר למצב לא פעיל ולא נמחק.',
    searchLabel: 'חיפוש במיקומים',
  },
} as const;

const DRAG_SCREEN_READER_INSTRUCTIONS = {
  draggable:
    'לחצו על מקש הרווח כדי להתחיל בגרירה של הפריט. השתמשו בחצים למעלה ולמטה כדי להעביר את הפריט למיקום אחר בתוך הקטגוריה, לחצו שוב על הרווח כדי לשמור את המיקום החדש, או על מקש Escape כדי לבטל את הגרירה ולחזור למיקום הקודם. לא ניתן להעביר פריט לקטגוריה אחרת בגרירה -- לשם כך יש להשתמש בפעולת השינוי סוג.',
};

function usePrefersReducedMotion(): boolean {
  return useMemo(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);
}

/**
 * Compact drag handle: grip-dots icon only, no permanent border/background/
 * square -- the hit target (size-9, touch-none) stays large enough for
 * reliable mouse/touch dragging without consuming its own row or widening
 * the card. Keyboard focus gets the app-wide :focus-visible ring (see
 * index.css) automatically, with no bespoke styling needed here.
 */
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
      className="flex size-9 shrink-0 touch-none items-center justify-center rounded-lg text-text-muted hover:text-text-primary active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
      style={{ cursor: disabled ? undefined : 'grab' }}
    >
      <IconGripVertical className="size-4.5" />
    </button>
  );
}

/** Compact single-row card: drag handle (right, RTL) -- identity/status
 *  (center) -- three-dot actions menu (left, RTL). Replaces the old
 *  bordered drag-handle square and the always-visible rename/deactivate/
 *  delete button row entirely. */
function ConfigRow({
  record,
  canReorder,
  canManage,
  busy,
  onOpenRename,
  onOpenChangeCategory,
  onReactivate,
  onDeactivateRequest,
  onDeleteRequest,
}: {
  record: ConfigRecord;
  canReorder: boolean;
  canManage: boolean;
  busy: boolean;
  onOpenRename: () => void;
  onOpenChangeCategory: () => void;
  onReactivate: () => void;
  onDeactivateRequest: () => void;
  onDeleteRequest: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: record.id,
    disabled: !canReorder || busy,
  });
  const prefersReducedMotion = usePrefersReducedMotion();

  const items: ActionMenuItem[] = [
    { label: 'שינוי שם', onSelect: onOpenRename, disabled: busy },
    { label: 'שינוי סוג', onSelect: onOpenChangeCategory, disabled: busy },
    record.archived
      ? { label: 'הפעלה מחדש', onSelect: onReactivate, disabled: busy }
      : { label: 'השבתה', onSelect: onDeactivateRequest, disabled: busy },
    { label: 'מחיקה', destructive: true, onSelect: onDeleteRequest, disabled: busy },
  ];

  return (
    <article
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: prefersReducedMotion ? undefined : transition,
      }}
      className={`flex items-center gap-2 px-3 py-2.5 ${
        isDragging ? 'relative z-10 rounded-lg bg-surface shadow-lg ring-2 ring-brand-500 dark:ring-brand-400' : ''
      }`}
    >
      {canReorder && (
        <DragHandle recordName={record.name} disabled={busy} attributes={attributes} listeners={listeners} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className={`truncate text-sm font-medium ${record.archived ? 'text-muted' : 'text-text-primary'}`}>
            {record.name}
          </p>
          <Badge color={record.archived ? 'neutral' : 'green'}>{record.archived ? 'לא פעיל' : 'פעיל'}</Badge>
        </div>
      </div>
      {canManage && <ActionMenu label={`פעולות עבור ${record.name}`} items={items} />}
    </article>
  );
}

/** One fixed-category section: heading with a live item count, a compact
 *  empty state when the category currently has no (matching) records, or a
 *  self-contained sortable list otherwise. Every category gets its own
 *  DndContext/SortableContext scope -- dragging can reorder only within
 *  this list and never presents another category as a drop target. */
function CategorySection({
  categoryKey,
  label,
  records,
  canReorder,
  canManage,
  busy,
  searching,
  onDragEnd,
  onOpenRename,
  onOpenChangeCategory,
  onReactivate,
  onDeactivateRequest,
  onDeleteRequest,
}: {
  categoryKey: string;
  label: string;
  records: ConfigRecord[];
  canReorder: boolean;
  canManage: boolean;
  busy: boolean;
  searching: boolean;
  onDragEnd: (event: DragEndEvent) => void;
  onOpenRename: (record: ConfigRecord) => void;
  onOpenChangeCategory: (record: ConfigRecord) => void;
  onReactivate: (record: ConfigRecord) => void;
  onDeactivateRequest: (record: ConfigRecord) => void;
  onDeleteRequest: (record: ConfigRecord) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const recordName = (id: string) => records.find((record) => record.id === String(id))?.name ?? '';
  const announcements: Announcements = {
    onDragStart({ active }) {
      return `הוחל בגרירת ${recordName(String(active.id))} בתוך ${label}.`;
    },
    onDragOver({ active, over }) {
      if (!over) return `${recordName(String(active.id))} אינו ממוקם מעל פריט אחר כרגע.`;
      if (over.id === active.id) return `${recordName(String(active.id))} חזר למיקומו המקורי.`;
      return `${recordName(String(active.id))} ממוקם כעת במקום ${recordName(String(over.id))}.`;
    },
    onDragEnd({ active, over }) {
      if (!over || over.id === active.id) return `הגרירה של ${recordName(String(active.id))} בוטלה.`;
      return `הסדר עודכן: ${recordName(String(active.id))} הועבר למיקום חדש בתוך ${label}.`;
    },
    onDragCancel({ active }) {
      return `הגרירה של ${recordName(String(active.id))} בוטלה, הסדר הקודם נשמר.`;
    },
  };
  const headingId = `config-category-${categoryKey}`;

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="px-1 text-xs font-bold tracking-wide text-muted uppercase">
        {label} ({records.length})
      </h2>
      {records.length === 0 ? (
        <div className="mt-1.5 rounded-lg border border-dashed border-hairline-strong bg-surface/60 px-3 py-3 text-center text-xs text-muted">
          {searching ? 'אין תוצאות התואמות לחיפוש בקטגוריה זו' : 'אין פריטים בקטגוריה זו'}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
          accessibility={{ announcements, screenReaderInstructions: DRAG_SCREEN_READER_INSTRUCTIONS }}
        >
          <SortableContext items={records.map((record) => record.id)} strategy={verticalListSortingStrategy}>
            <div className="surface mt-1.5 divide-y divide-hairline" aria-label={`רשימת ${label}`}>
              {records.map((record) => (
                <ConfigRow
                  key={record.id}
                  record={record}
                  canReorder={canReorder}
                  canManage={canManage}
                  busy={busy}
                  onOpenRename={() => onOpenRename(record)}
                  onOpenChangeCategory={() => onOpenChangeCategory(record)}
                  onReactivate={() => onReactivate(record)}
                  onDeactivateRequest={() => onDeactivateRequest(record)}
                  onDeleteRequest={() => onDeleteRequest(record)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}

function ConfigTab({ kind }: { kind: ConfigKind }) {
  const session = useSession();
  const canManage = hasCapability(session.role, 'manage_config');
  const systemsQ = useSystems();
  const locationsQ = useLocations();
  const query = kind === 'systems' ? systemsQ : locationsQ;
  const data = query.data as ConfigRecord[] | undefined;
  const copy = CONFIG_COPY[kind];
  const categoryOrder: string[] = kind === 'systems' ? SYSTEM_CATEGORY_ORDER : LOCATION_CATEGORY_ORDER;
  const categoryLabels: Record<string, string> = kind === 'systems' ? systemCategoryLabels : locationCategoryLabels;
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState(categoryOrder[0]);
  const [renaming, setRenaming] = useState<ConfigRecord | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [changingCategory, setChangingCategory] = useState<ConfigRecord | null>(null);
  const [confirming, setConfirming] = useState<
    { type: 'deactivate' | 'delete'; record: ConfigRecord } | null
  >(null);
  const [orderedRecords, setOrderedRecords] = useState<ConfigRecord[]>([]);
  const previousOrderRef = useRef<ConfigRecord[]>([]);

  const create = useAppMutation<{ name: string; category: string }, ConfigRecord>(
    (vars) =>
      kind === 'systems'
        ? repo().createSystem(session, vars.name, vars.category as SystemCategory)
        : repo().createLocation(session, vars.name, vars.category as LocationCategory),
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
  const changeCategory = useAppMutation(
    (vars: { id: string; category: string }) =>
      kind === 'systems'
        ? repo().setSystemCategory(session, vars.id, vars.category as SystemCategory)
        : repo().setLocationCategory(session, vars.id, vars.category as LocationCategory),
    {
      successText: 'הסוג עודכן בהצלחה.',
      invalidate: [[kind]],
      onSuccess: () => setChangingCategory(null),
    },
  );

  useEffect(() => {
    if (reorder.isPending) return;
    setOrderedRecords(data ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, reorder.isPending]);

  const busy =
    create.isPending ||
    rename.isPending ||
    setArchived.isPending ||
    remove.isPending ||
    reorder.isPending ||
    changeCategory.isPending;

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && category && !create.isPending) create.mutate({ name, category });
  };

  const openRename = (record: ConfigRecord) => {
    setRenaming(record);
    setRenameValue(record.name);
  };

  const searching = search.trim().length > 0;
  const visibleRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return orderedRecords;
    return orderedRecords.filter((record) => record.name.toLowerCase().includes(q));
  }, [orderedRecords, search]);

  const groups = useMemo(
    () =>
      categoryOrder.map((cat) => ({
        category: cat,
        records: visibleRecords.filter((record) => record.category === cat),
      })),
    [categoryOrder, visibleRecords],
  );

  const handleDragEnd = (categoryRecords: ConfigRecord[]) => (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if (reorder.isPending) return;
    const oldIndex = categoryRecords.findIndex((record) => record.id === active.id);
    const newIndex = categoryRecords.findIndex((record) => record.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    previousOrderRef.current = orderedRecords;
    const reorderedCategory = arrayMove(categoryRecords, oldIndex, newIndex);
    const reorderedIds = new Set(reorderedCategory.map((record) => record.id));
    let cursor = 0;
    const next = orderedRecords.map((record) =>
      reorderedIds.has(record.id) ? reorderedCategory[cursor++] : record,
    );
    setOrderedRecords(next);
    reorder.mutate(reorderedCategory.map((record) => record.id));
  };

  return (
    <div>
      <form
        onSubmit={submitCreate}
        className="surface mb-4 grid grid-cols-1 items-start gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto]"
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
        <Field label="סוג" required>
          {(a) => (
            <Select
              {...a}
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              disabled={create.isPending}
            >
              {categoryOrder.map((cat) => (
                <option key={cat} value={cat}>
                  {categoryLabels[cat]}
                </option>
              ))}
            </Select>
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

      <div className="mb-4">
        <Input
          type="search"
          aria-label={copy.searchLabel}
          placeholder={`${copy.searchLabel}…`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {query.isLoading ? (
        <Spinner label={`טוען ${copy.plural}…`} />
      ) : query.isError ? (
        <ErrorState message={`שגיאה בטעינת ${copy.plural}.`} onRetry={() => query.refetch()} />
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <CategorySection
              key={group.category}
              categoryKey={group.category}
              label={categoryLabels[group.category]}
              records={group.records}
              canReorder={canManage && !searching}
              canManage={canManage}
              busy={busy}
              searching={searching}
              onDragEnd={handleDragEnd(group.records)}
              onOpenRename={openRename}
              onOpenChangeCategory={setChangingCategory}
              onReactivate={(record) => setArchived.mutate({ id: record.id, archived: false })}
              onDeactivateRequest={(record) => setConfirming({ type: 'deactivate', record })}
              onDeleteRequest={(record) => setConfirming({ type: 'delete', record })}
            />
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

      {changingCategory && (
        <ChangeCategoryDialog
          open
          recordName={changingCategory.name}
          currentCategory={changingCategory.category}
          categoryOrder={categoryOrder}
          categoryLabels={categoryLabels}
          submitting={changeCategory.isPending}
          onClose={() => !changeCategory.isPending && setChangingCategory(null)}
          onSubmit={(nextCategory) => changeCategory.mutate({ id: changingCategory.id, category: nextCategory })}
        />
      )}

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
