import type { IncidentStatus, Severity, Profile, SystemRecord, LocationRecord, ReportedToOps } from '../domain/types';
import { severityLabels, statusLabels, reportedToOpsLabels } from '../domain/labels';
import { Input, Select, Badge } from './ui';
import { useDebouncedField } from '../lib/useDebouncedField';

export interface FilterState {
  search: string;
  status: IncidentStatus[];
  severity: Severity[];
  ownerUserId?: string;
  systemId?: string;
  locationId?: string;
  overdueOnly: boolean;
  reportedToOps?: ReportedToOps;
  createdFrom?: string;
  createdTo?: string;
}

export const ALL_STATUSES: IncidentStatus[] = [
  'new', 'acknowledged', 'in_progress', 'waiting_external', 'waiting_test',
  'monitoring', 'partial_readiness', 'resolved_pending_close', 'closed', 'reopened',
];
export const ALL_SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

function toggle<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

export function IncidentFilterBar({
  value,
  onChange,
  profiles,
  systems,
  locations,
  statusOptions = ALL_STATUSES,
  extra,
}: {
  value: FilterState;
  onChange: (next: FilterState) => void;
  profiles?: Profile[];
  systems?: SystemRecord[];
  locations?: LocationRecord[];
  statusOptions?: IncidentStatus[];
  extra?: React.ReactNode;
}) {
  // Debounced local draft: typing must never be interrupted by the
  // URL/query round-trip that committing a search value triggers.
  const [searchDraft, setSearchDraft] = useDebouncedField(value.search, (next) =>
    onChange({ ...value, search: next }),
  );

  const chips: { key: string; label: string; onRemove: () => void }[] = [];
  value.status.forEach((s) =>
    chips.push({ key: `s-${s}`, label: statusLabels[s], onRemove: () => onChange({ ...value, status: toggle(value.status, s) }) }),
  );
  value.severity.forEach((s) =>
    chips.push({ key: `sv-${s}`, label: severityLabels[s], onRemove: () => onChange({ ...value, severity: toggle(value.severity, s) }) }),
  );
  if (value.ownerUserId) {
    const label = profiles?.find((p) => p.id === value.ownerUserId)?.fullName ?? 'גורם מטפל';
    chips.push({ key: 'owner', label, onRemove: () => onChange({ ...value, ownerUserId: undefined }) });
  }
  if (value.systemId) {
    const label = systems?.find((s) => s.id === value.systemId)?.name ?? 'מערכת';
    chips.push({ key: 'system', label, onRemove: () => onChange({ ...value, systemId: undefined }) });
  }
  if (value.locationId) {
    const label = locations?.find((l) => l.id === value.locationId)?.name ?? 'מיקום';
    chips.push({ key: 'location', label, onRemove: () => onChange({ ...value, locationId: undefined }) });
  }
  if (value.overdueOnly) {
    chips.push({ key: 'overdue', label: 'באיחור בלבד', onRemove: () => onChange({ ...value, overdueOnly: false }) });
  }
  if (value.reportedToOps) {
    chips.push({
      key: 'ops',
      label: `דווח למבצעים: ${reportedToOpsLabels[value.reportedToOps]}`,
      onRemove: () => onChange({ ...value, reportedToOps: undefined }),
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900">
      <Input
        placeholder="חיפוש לפי מספר, מערכת, מיקום, תיאור או גורם מטפל…"
        value={searchDraft}
        onChange={(e) => setSearchDraft(e.target.value)}
        aria-label="חיפוש תקלות"
      />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Select
          aria-label="סינון לפי חומרה"
          value=""
          onChange={(e) => {
            if (e.target.value) onChange({ ...value, severity: toggle(value.severity, e.target.value as Severity) });
          }}
        >
          <option value="">חומרה…</option>
          {ALL_SEVERITIES.map((s) => (
            <option key={s} value={s} disabled={value.severity.includes(s)}>
              {severityLabels[s]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="סינון לפי סטטוס"
          value=""
          onChange={(e) => {
            if (e.target.value) onChange({ ...value, status: toggle(value.status, e.target.value as IncidentStatus) });
          }}
        >
          <option value="">סטטוס…</option>
          {statusOptions.map((s) => (
            <option key={s} value={s} disabled={value.status.includes(s)}>
              {statusLabels[s]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="סינון לפי גורם מטפל"
          value={value.ownerUserId ?? ''}
          onChange={(e) => onChange({ ...value, ownerUserId: e.target.value || undefined })}
        >
          <option value="">גורם מטפל…</option>
          {profiles?.filter((p) => p.active).map((p) => (
            <option key={p.id} value={p.id}>{p.fullName}</option>
          ))}
        </Select>
        <Select
          aria-label="סינון לפי מערכת"
          value={value.systemId ?? ''}
          onChange={(e) => onChange({ ...value, systemId: e.target.value || undefined })}
        >
          <option value="">מערכת / עמדה…</option>
          {systems?.map((s) => (
            <option key={s.id} value={s.id}>{s.name}{s.archived ? ' (בארכיון)' : ''}</option>
          ))}
        </Select>
        <Select
          aria-label="סינון לפי מיקום"
          value={value.locationId ?? ''}
          onChange={(e) => onChange({ ...value, locationId: e.target.value || undefined })}
        >
          <option value="">מיקום…</option>
          {locations?.map((l) => (
            <option key={l.id} value={l.id}>{l.name}{l.archived ? ' (בארכיון)' : ''}</option>
          ))}
        </Select>
        <Select
          aria-label="סינון לפי דיווח למבצעים"
          value={value.reportedToOps ?? ''}
          onChange={(e) => onChange({ ...value, reportedToOps: (e.target.value || undefined) as ReportedToOps | undefined })}
        >
          <option value="">דווח למבצעים…</option>
          <option value="yes">כן</option>
          <option value="no">לא</option>
          <option value="not_required">לא נדרש</option>
        </Select>
        <label className="flex items-center gap-2 rounded-lg border border-neutral-300 px-3 text-sm dark:border-neutral-600">
          <input
            type="checkbox"
            checked={value.overdueOnly}
            onChange={(e) => onChange({ ...value, overdueOnly: e.target.checked })}
          />
          באיחור בלבד
        </label>
        {extra}
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button key={c.key} type="button" onClick={c.onRemove} className="rounded-md">
              <Badge color="blue" className="gap-1">
                {c.label} <span aria-hidden>✕</span>
              </Badge>
            </button>
          ))}
          <button
            type="button"
            className="text-xs text-neutral-500 underline"
            onClick={() =>
              onChange({
                search: value.search,
                status: [],
                severity: [],
                overdueOnly: false,
              })
            }
          >
            ניקוי כל הסינונים
          </button>
        </div>
      )}
    </div>
  );
}
