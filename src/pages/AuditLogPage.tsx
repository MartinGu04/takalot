// יומן ביקורת (system-wide audit log): professional_manager / system_admin
// only. The route itself also rejects other roles (App.tsx, cap=
// "view_audit_log"); this page additionally hides its own nav entry for
// everyone else (navItems.tsx) -- neither alone is sufficient on its own,
// the database is the real authorization boundary (RLS + list_audit_events'
// own role check, migration 0042).
import { useState } from 'react';
import { useAuditLogs, useProfiles } from '../data/hooks';
import { useUrlState } from '../lib/useUrlState';
import { auditActionLabels, auditEntityTypeLabels } from '../domain/labels';
import { formatDateTime } from '../lib/time';
import { Button, EmptyState, ErrorState, Field, Input, Select, Spinner } from '../components/ui';
import { useDebouncedField } from '../lib/useDebouncedField';
import { IconChevronDown } from '../components/icons';
import type { AuditFilters } from '../data/repository';
import type { AuditLog } from '../domain/types';

const PAGE_SIZE = 25;

function actionLabel(action: string): string {
  return auditActionLabels[action] ?? action;
}

function entityTypeLabel(entityType: string): string {
  return auditEntityTypeLabels[entityType] ?? entityType;
}

function parseJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A single before/after (or metadata) object rendered as label: value rows. */
function ValueBlock({ title, value }: { title: string; value: Record<string, unknown> | null }) {
  if (!value || Object.keys(value).length === 0) return null;
  return (
    <div className="min-w-0 flex-1">
      <p className="text-xs font-semibold text-text-secondary">{title}</p>
      <dl className="mt-1 flex flex-col gap-0.5">
        {Object.entries(value).map(([key, val]) => (
          <div key={key} className="flex flex-wrap gap-1 text-xs">
            <dt className="font-medium text-muted">{key}:</dt>
            <dd className="min-w-0 break-words">
              <bdi dir="auto">{val === null || val === undefined ? '—' : String(val)}</bdi>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function AuditLogRow({ log }: { log: AuditLog }) {
  const [open, setOpen] = useState(false);
  const before = parseJson(log.before);
  const after = parseJson(log.after);
  const metadata = parseJson(log.metadata);
  const hasDetails = !!(before || after || metadata);

  return (
    <li className="surface p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-text-primary">{actionLabel(log.action)}</p>
          <p className="mt-0.5 text-xs text-muted">
            {log.actorDisplayName ?? 'המערכת'} · {formatDateTime(log.createdAt)}
          </p>
        </div>
        <span className="whitespace-nowrap rounded-md border border-hairline bg-surface-active px-2 py-0.5 text-xs text-text-secondary">
          {entityTypeLabel(log.entityType)}
          {log.entityLabel ? ` · ${log.entityLabel}` : ''}
        </span>
      </div>
      {log.summary && <p className="mt-2 text-sm text-text-secondary">{log.summary}</p>}
      {hasDetails && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            <IconChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
            {open ? 'הסתרת פרטים' : 'הצגת פרטים'}
          </button>
          {open && (
            <div className="mt-2 flex flex-col gap-2 rounded-lg bg-surface-active/60 p-2.5 sm:flex-row sm:gap-4">
              <ValueBlock title="לפני" value={before} />
              <ValueBlock title="אחרי" value={after} />
              <ValueBlock title="פרטים נוספים" value={metadata} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function filtersFromUrl(url: ReturnType<typeof useUrlState>): AuditFilters {
  return {
    search: url.get('q'),
    actorId: url.get('actor'),
    entityType: url.get('entityType'),
    action: url.get('action'),
    from: url.get('from') ? new Date(url.get('from')! + 'T00:00:00').toISOString() : undefined,
    to: url.get('to') ? new Date(url.get('to')! + 'T23:59:59').toISOString() : undefined,
  };
}

export default function AuditLogPage() {
  const url = useUrlState();
  const filters = filtersFromUrl(url);
  const page = Number(url.get('page') ?? '1');
  const { data: profiles } = useProfiles();
  const { data, isLoading, isError, refetch, isFetching } = useAuditLogs(filters, page, PAGE_SIZE, true);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const setFilters = (patch: Partial<{ q: string; actor: string; entityType: string; action: string; from: string; to: string }>) => {
    url.setMany({ ...patch, page: undefined });
  };
  // Debounced local draft: typing must never be interrupted by the
  // URL/query round-trip a committed search value triggers -- same pattern
  // as IncidentFilterBar's own search field.
  const [searchDraft, setSearchDraft] = useDebouncedField(filters.search ?? '', (next) => setFilters({ q: next }));

  return (
    <div>
      <h1 className="page-title">יומן ביקורת</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        רישום מלא של פעולות ניהוליות ותפעוליות משמעותיות במערכת — שינויי הרשאות, ניהול משתמשים, מערכות
        ומיקומים, ומחזור החיים של תקלות. הרישום אינו ניתן לשינוי או מחיקה.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="חיפוש">
          {(props) => (
            <Input
              {...props}
              placeholder="לפי מספר תקלה, שם ישות, או תקציר…"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
            />
          )}
        </Field>
        <Field label="סוג ישות">
          {(props) => (
            <Select {...props} value={filters.entityType ?? ''} onChange={(e) => setFilters({ entityType: e.target.value })}>
              <option value="">הכול</option>
              {Object.entries(auditEntityTypeLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="פעולה">
          {(props) => (
            <Select {...props} value={filters.action ?? ''} onChange={(e) => setFilters({ action: e.target.value })}>
              <option value="">הכול</option>
              {Object.entries(auditActionLabels)
                .sort((a, b) => a[1].localeCompare(b[1], 'he'))
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="משתמש מבצע">
          {(props) => (
            <Select {...props} value={filters.actorId ?? ''} onChange={(e) => setFilters({ actor: e.target.value })}>
              <option value="">הכול</option>
              {(profiles ?? [])
                .slice()
                .sort((a, b) => a.fullName.localeCompare(b.fullName, 'he'))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullName}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="מתאריך">
          {(props) => (
            <Input
              {...props}
              type="date"
              defaultValue={url.get('from') ?? ''}
              onChange={(e) => setFilters({ from: e.target.value })}
            />
          )}
        </Field>
        <Field label="עד תאריך">
          {(props) => (
            <Input
              {...props}
              type="date"
              defaultValue={url.get('to') ?? ''}
              onChange={(e) => setFilters({ to: e.target.value })}
            />
          )}
        </Field>
      </div>

      <div className="mt-4">
        {isLoading ? (
          <Spinner label="טוען יומן ביקורת…" />
        ) : isError ? (
          <ErrorState message="שגיאה בטעינת יומן הביקורת." onRetry={() => refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title="אין רישומים התואמים לסינון" subtitle="ניתן לנקות סינונים או לשנות את החיפוש." />
        ) : (
          <>
            <p className="text-sm text-muted">
              {total} רישומים תואמים{isFetching ? ' · מרענן…' : ''}
            </p>
            <ul className="mt-2 flex flex-col gap-2">
              {items.map((log) => (
                <AuditLogRow key={log.id} log={log} />
              ))}
            </ul>
            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-center gap-3">
                <Button variant="secondary" disabled={page <= 1} onClick={() => url.set('page', String(page - 1))}>
                  הקודם
                </Button>
                <span className="text-sm text-muted">
                  עמוד {page} מתוך {totalPages}
                </span>
                <Button
                  variant="secondary"
                  disabled={page >= totalPages}
                  onClick={() => url.set('page', String(page + 1))}
                >
                  הבא
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
