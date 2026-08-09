// Filter bar for the ניתוחים (analytics) page: period, system, location,
// severity (multi-select), and an advanced disclosure for domain/confirmed-
// cause/treatment-outcome (also multi-select) -- 7 filters total, page-wide
// (see analyticsSummary.ts's matchesEntityFilters). System/location stay
// single-select: the rankings module already surfaces cross-entity
// comparison, so "drill into one system/location" is the dominant use case.
//
// Desktop: period row + primary row (system/location/severity) + a
// collapsible "סינון מתקדם" disclosure for the three page-wide closure-
// scoped filters, badge-counted when collapsed and non-empty. Every desktop
// control applies instantly, same as before v1.4.0.
//
// Mobile (<sm): period stays its own always-visible row (a single tap,
// no reason to hide it); every other filter moves into a "סינון" button
// that opens the existing Dialog primitive (auto bottom-sheet on mobile,
// same mechanism as MobileMoreSheet) as a DRAFT -- changes only take effect
// on "החל", and "איפוס" resets the draft, so a half-finished multi-select
// selection is never applied mid-edit by an accidental outside tap.
import { useEffect, useState } from 'react';
import type { AnalyticsFilters, AnalyticsPeriodDays } from '../../domain/analyticsSummary';
import type { LocationRecord, SystemRecord } from '../../domain/types';
import { SEVERITY_ORDER } from '../../domain/types';
import {
  CONFIRMED_CAUSE_ORDER,
  INCIDENT_DOMAIN_ORDER,
  TREATMENT_OUTCOME_ORDER,
  UNCLASSIFIED_DOMAIN_LABEL,
  confirmedCauseLabels,
  incidentDomainLabels,
  severityLabels,
  treatmentOutcomeLabels,
} from '../../domain/labels';
import { SystemOptions, LocationOptions } from '../ReferenceDataOptions';
import { Badge, Button, Dialog, Disclosure, Select } from '../ui';

const PERIODS: AnalyticsPeriodDays[] = [7, 30, 90];

export const DEFAULT_ANALYTICS_FILTERS: AnalyticsFilters = { periodDays: 30 };

function toggle<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

function len(arr?: unknown[]): number {
  return arr?.length ?? 0;
}

export function isDefaultAnalyticsFilters(value: AnalyticsFilters): boolean {
  return (
    value.periodDays === DEFAULT_ANALYTICS_FILTERS.periodDays &&
    !value.systemId &&
    !value.locationId &&
    len(value.severities) === 0 &&
    len(value.domains) === 0 &&
    !value.includeUnclassifiedDomain &&
    len(value.confirmedCauses) === 0 &&
    len(value.treatmentOutcomes) === 0
  );
}

/** Every non-period filter currently active -- shown on the mobile "סינון"
 *  trigger so a collapsed sheet never hides an active filter silently. */
function activeFilterCount(value: AnalyticsFilters): number {
  return (
    (value.systemId ? 1 : 0) +
    (value.locationId ? 1 : 0) +
    len(value.severities) +
    len(value.domains) +
    (value.includeUnclassifiedDomain ? 1 : 0) +
    len(value.confirmedCauses) +
    len(value.treatmentOutcomes)
  );
}

/** Just the three "סינון מתקדם" fields -- shown on the disclosure's own
 *  collapsed-state badge. */
function advancedFilterCount(value: AnalyticsFilters): number {
  return len(value.domains) + (value.includeUnclassifiedDomain ? 1 : 0) + len(value.confirmedCauses) + len(value.treatmentOutcomes);
}

function PeriodControl({ value, onChange }: { value: AnalyticsPeriodDays; onChange: (p: AnalyticsPeriodDays) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="תקופה">
      {PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          aria-pressed={value === p}
          className={
            value === p
              ? 'min-h-9 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white dark:bg-brand-500'
              : 'min-h-9 rounded-lg bg-surface-active px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-surface-hover'
          }
        >
          {p} ימים
        </button>
      ))}
    </div>
  );
}

/** "Select to add, chip to remove" -- the same multi-select pattern
 *  IncidentFilterBar already established for its severity chips. */
function MultiSelectField<T extends string>({
  ariaLabel,
  placeholder,
  order,
  labels,
  selected,
  onChange,
}: {
  ariaLabel: string;
  placeholder: string;
  order: readonly T[];
  labels: Record<T, string>;
  selected: T[];
  onChange: (next: T[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Select
        aria-label={ariaLabel}
        className="min-w-0"
        value=""
        onChange={(e) => {
          if (e.target.value) onChange(toggle(selected, e.target.value as T));
        }}
      >
        <option value="">{placeholder}</option>
        {order.map((o) => (
          <option key={o} value={o} disabled={selected.includes(o)}>
            {labels[o]}
          </option>
        ))}
      </Select>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onChange(toggle(selected, v))}
              aria-label={`הסרת סינון: ${labels[v]}`}
              className="rounded-md"
            >
              <Badge color="brand" className="gap-1">
                {labels[v]} <span aria-hidden>✕</span>
              </Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The three page-wide, closure-scoped filters -- domain (+ the explicit
 *  "לא סווג" chip for a null reportedDomain), confirmed cause, and treatment
 *  outcome. Shared between the desktop disclosure and the mobile sheet. */
function AdvancedFilterFields({ value, onChange }: { value: AnalyticsFilters; onChange: (next: AnalyticsFilters) => void }) {
  const hasClosureScope = len(value.confirmedCauses) > 0 || len(value.treatmentOutcomes) > 0;
  return (
    <>
      <div className="flex flex-col gap-2">
        <MultiSelectField
          ariaLabel="סינון לפי תחום"
          placeholder="הוספת תחום…"
          order={INCIDENT_DOMAIN_ORDER}
          labels={incidentDomainLabels}
          selected={value.domains ?? []}
          onChange={(next) => onChange({ ...value, domains: next.length > 0 ? next : undefined })}
        />
        <button
          type="button"
          onClick={() => onChange({ ...value, includeUnclassifiedDomain: !value.includeUnclassifiedDomain })}
          aria-pressed={!!value.includeUnclassifiedDomain}
          className="w-fit rounded-md"
        >
          <Badge color={value.includeUnclassifiedDomain ? 'brand' : 'neutral'} className="gap-1">
            {UNCLASSIFIED_DOMAIN_LABEL} {value.includeUnclassifiedDomain && <span aria-hidden>✕</span>}
          </Badge>
        </button>
      </div>
      <MultiSelectField
        ariaLabel="סינון לפי גורם שאומת"
        placeholder="הוספת גורם שאומת…"
        order={CONFIRMED_CAUSE_ORDER}
        labels={confirmedCauseLabels}
        selected={value.confirmedCauses ?? []}
        onChange={(next) => onChange({ ...value, confirmedCauses: next.length > 0 ? next : undefined })}
      />
      <MultiSelectField
        ariaLabel="סינון לפי תוצאת טיפול"
        placeholder="הוספת תוצאת טיפול…"
        order={TREATMENT_OUTCOME_ORDER}
        labels={treatmentOutcomeLabels}
        selected={value.treatmentOutcomes ?? []}
        onChange={(next) => onChange({ ...value, treatmentOutcomes: next.length > 0 ? next : undefined })}
      />
      {hasClosureScope && (
        <p className="text-xs text-muted">
          מסנן לפי סיווג סגירה כולל רק תקלות שנסגרו — תקלות פתוחות לא יופיעו כל עוד סינון זה פעיל.
        </p>
      )}
    </>
  );
}

export function AnalyticsFilterBar({
  value,
  onChange,
  onReset,
  systems,
  locations,
}: {
  value: AnalyticsFilters;
  onChange: (next: AnalyticsFilters) => void;
  onReset: () => void;
  systems?: SystemRecord[];
  locations?: LocationRecord[];
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [draft, setDraft] = useState<AnalyticsFilters>(value);

  // The sheet always starts from the currently-applied filters, never a
  // stale earlier draft (e.g. from a previous open that was cancelled).
  useEffect(() => {
    if (mobileOpen) setDraft(value);
  }, [mobileOpen, value]);

  const advancedCount = advancedFilterCount(value);
  const activeCount = activeFilterCount(value);

  return (
    <div className="surface flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PeriodControl value={value.periodDays} onChange={(p) => onChange({ ...value, periodDays: p })} />
        <Button variant="secondary" className="sm:hidden" onClick={() => setMobileOpen(true)}>
          סינון{activeCount > 0 ? ` (${activeCount})` : ''}
        </Button>
      </div>

      {/* Desktop-only: mobile uses the "סינון" sheet above instead. */}
      <div className="hidden flex-col gap-3 sm:flex">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Select
            aria-label="סינון לפי מערכת"
            className="min-w-0"
            value={value.systemId ?? ''}
            onChange={(e) => onChange({ ...value, systemId: e.target.value || undefined })}
          >
            <option value="">כל המערכות</option>
            <SystemOptions systems={systems} includeArchived />
          </Select>
          <Select
            aria-label="סינון לפי מיקום"
            className="min-w-0"
            value={value.locationId ?? ''}
            onChange={(e) => onChange({ ...value, locationId: e.target.value || undefined })}
          >
            <option value="">כל המיקומים</option>
            <LocationOptions locations={locations} includeArchived />
          </Select>
          <MultiSelectField
            ariaLabel="סינון לפי חומרה"
            placeholder="כל החומרות"
            order={SEVERITY_ORDER}
            labels={severityLabels}
            selected={value.severities ?? []}
            onChange={(next) => onChange({ ...value, severities: next.length > 0 ? next : undefined })}
          />
          <Button variant="ghost" onClick={onReset} disabled={isDefaultAnalyticsFilters(value)} className="min-w-0">
            איפוס סינונים
          </Button>
        </div>
        <Disclosure
          label={`סינון מתקדם${advancedCount > 0 ? ` (${advancedCount})` : ''}`}
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
        >
          <AdvancedFilterFields value={value} onChange={onChange} />
        </Disclosure>
      </div>

      <Dialog open={mobileOpen} onClose={() => setMobileOpen(false)} title="סינון">
        <div className="flex flex-col gap-4">
          <Select
            aria-label="סינון לפי מערכת"
            className="min-w-0"
            value={draft.systemId ?? ''}
            onChange={(e) => setDraft({ ...draft, systemId: e.target.value || undefined })}
          >
            <option value="">כל המערכות</option>
            <SystemOptions systems={systems} includeArchived />
          </Select>
          <Select
            aria-label="סינון לפי מיקום"
            className="min-w-0"
            value={draft.locationId ?? ''}
            onChange={(e) => setDraft({ ...draft, locationId: e.target.value || undefined })}
          >
            <option value="">כל המיקומים</option>
            <LocationOptions locations={locations} includeArchived />
          </Select>
          <MultiSelectField
            ariaLabel="סינון לפי חומרה"
            placeholder="הוספת חומרה…"
            order={SEVERITY_ORDER}
            labels={severityLabels}
            selected={draft.severities ?? []}
            onChange={(next) => setDraft({ ...draft, severities: next.length > 0 ? next : undefined })}
          />
          <AdvancedFilterFields value={draft} onChange={setDraft} />
          <div className="flex gap-2 border-t border-hairline pt-3">
            <Button
              variant="ghost"
              className="flex-1"
              onClick={() => setDraft({ periodDays: draft.periodDays })}
            >
              איפוס
            </Button>
            <Button
              className="flex-1"
              onClick={() => {
                onChange(draft);
                setMobileOpen(false);
              }}
            >
              החל
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
