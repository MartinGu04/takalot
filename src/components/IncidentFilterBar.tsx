import type { Severity, Profile, SystemRecord, LocationRecord } from '../domain/types';
import { severityLabels } from '../domain/labels';
import { SystemOptions, LocationOptions, EligibleOwnerOptions } from './ReferenceDataOptions';
import { Input, Select, Badge, filterFieldClass, filterControlClass } from './ui';
import { useDebouncedField } from '../lib/useDebouncedField';

export interface FilterState {
  search: string;
  severity: Severity[];
  ownerUserId?: string;
  systemId?: string;
  locationId?: string;
  createdFrom?: string;
  createdTo?: string;
}

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
  extra,
}: {
  value: FilterState;
  onChange: (next: FilterState) => void;
  profiles?: Profile[];
  systems?: SystemRecord[];
  locations?: LocationRecord[];
  extra?: React.ReactNode;
}) {
  // Debounced local draft: typing must never be interrupted by the
  // URL/query round-trip that committing a search value triggers.
  const [searchDraft, setSearchDraft] = useDebouncedField(value.search, (next) =>
    onChange({ ...value, search: next }),
  );

  const chips: { key: string; label: string; onRemove: () => void }[] = [];
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
  return (
    <div className="surface flex flex-col gap-2 p-2">
      <Input
        className={filterFieldClass}
        placeholder="חיפוש לפי מספר, מערכת, מיקום, תיאור או גורם מטפל…"
        value={searchDraft}
        onChange={(e) => setSearchDraft(e.target.value)}
        aria-label="חיפוש תקלות"
      />
      {/* Desktop: one compact row of four equal columns, right-to-left as
          חומרה -> מערכת/עמדה -> גורם מטפל -> מיקום. A real grid (not flex +
          shrink-to-content) so each control reliably fills its own column
          instead of the browser resolving a `w-full`/`w-auto` conflict on
          its own -- two columns on tablet, one on mobile. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          aria-label="סינון לפי חומרה"
          className={filterControlClass}
          value=""
          onChange={(e) => {
            if (e.target.value) onChange({ ...value, severity: toggle(value.severity, e.target.value as Severity) });
          }}
        >
          <option value="">הוספת חומרה…</option>
          {ALL_SEVERITIES.map((s) => (
            <option key={s} value={s} disabled={value.severity.includes(s)}>
              {severityLabels[s]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="סינון לפי מערכת"
          className={filterControlClass}
          value={value.systemId ?? ''}
          onChange={(e) => onChange({ ...value, systemId: e.target.value || undefined })}
        >
          <option value="">מערכת / עמדה…</option>
          <SystemOptions systems={systems} includeArchived />
        </Select>
        <Select
          aria-label="סינון לפי גורם מטפל"
          className={filterControlClass}
          value={value.ownerUserId ?? ''}
          onChange={(e) => onChange({ ...value, ownerUserId: e.target.value || undefined })}
        >
          <option value="">כל הגורמים המטפלים</option>
          <EligibleOwnerOptions profiles={profiles} />
        </Select>
        <Select
          aria-label="סינון לפי מיקום"
          className={filterControlClass}
          value={value.locationId ?? ''}
          onChange={(e) => onChange({ ...value, locationId: e.target.value || undefined })}
        >
          <option value="">מיקום…</option>
          <LocationOptions locations={locations} includeArchived />
        </Select>
        {extra}
      </div>
      {chips.length > 0 && (
        <div
          role="group"
          aria-label="מסננים פעילים"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 p-2.5 dark:border-brand-900 dark:bg-brand-950/40"
        >
          <span className="text-xs font-semibold text-brand-900 dark:text-brand-200">מסננים פעילים:</span>
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={c.onRemove}
                aria-label={`הסרת סינון: ${c.label}`}
                className="rounded-md"
              >
                <Badge color="brand" className="gap-1 border-brand-400 font-medium dark:border-brand-700">
                  {c.label} <span aria-hidden>✕</span>
                </Badge>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="text-xs font-medium text-brand-800 underline hover:text-brand-950 dark:text-brand-300 dark:hover:text-brand-100"
            onClick={() =>
              onChange({
                search: value.search,
                severity: [],
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
