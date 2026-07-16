// Complete active-incidents list: search, filters, sort, pagination, bulk export.
import { useMemo, useState } from 'react';
import { useIncidents, useLocations, useProfiles, useSystems, useCanExport, useAppMutation, repo } from '../data/hooks';
import { useSession } from '../auth/AuthContext';
import { IncidentFilterBar, ALL_STATUSES, type FilterState } from '../components/IncidentFilterBar';
import { IncidentCard } from '../components/incident';
import { Button, EmptyState, ErrorState, Select, Spinner, useToast } from '../components/ui';
import { useUrlState } from '../lib/useUrlState';
import type { IncidentStatus, Severity, ReportedToOps, Incident } from '../domain/types';
import type { IncidentSort } from '../data/repository';
import { incidentsExportFilename, incidentsToCsv, incidentsToXlsxBlob, downloadBlob } from '../exports/table';

const PAGE_SIZE = 20;

// Closed incidents belong in the archive, never in the active incidents
// list -- including closed incidents with incomplete readiness, which
// surface instead in the dashboard's dedicated section. Reopened incidents
// are not closed, so they remain active here.
const ACTIVE_STATUS_OPTIONS = ALL_STATUSES.filter((s) => s !== 'closed');

function filtersFromUrl(url: ReturnType<typeof useUrlState>): FilterState {
  return {
    search: url.get('q') ?? '',
    status: url.getList('status') as IncidentStatus[],
    severity: url.getList('severity') as Severity[],
    ownerUserId: url.get('owner'),
    systemId: url.get('system'),
    locationId: url.get('location'),
    overdueOnly: url.get('overdue') === '1',
    reportedToOps: url.get('ops') as ReportedToOps | undefined,
  };
}

export default function IncidentsPage() {
  const url = useUrlState();
  const filters = filtersFromUrl(url);
  const sort = (url.get('sort') as IncidentSort) ?? 'priority';
  const page = Number(url.get('page') ?? '1');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toast = useToast();
  const session = useSession();

  // The active incidents page always excludes closed incidents -- this is
  // not a default a filter can override, it's what makes this page "active
  // incidents" rather than "all incidents". Closed incidents (including ones
  // with incomplete readiness) live in the archive and the dashboard's
  // dedicated section, never here.
  const { data: incidents, isLoading, isError, refetch } = useIncidents(
    { ...filters, openOnly: true },
    sort,
  );
  const { data: profiles } = useProfiles();
  const { data: systems } = useSystems();
  const { data: locations } = useLocations();
  const { data: canExport } = useCanExport();
  const now = new Date();

  const exportMutation = useAppMutation(
    async (kind: 'xlsx' | 'csv') => {
      const rows = selected.size > 0 ? (incidents ?? []).filter((i) => selected.has(i.id)) : incidents ?? [];
      const ctx = { profiles: profiles ?? [], systems: systems ?? [], locations: locations ?? [], now };
      await repo().recordExport(session, {
        exportType: kind === 'xlsx' ? 'incidents_xlsx' : 'incidents_csv',
        filtersDescription: JSON.stringify(filters),
      });
      if (rows.length === 0) {
        toast('אין שורות התואמות לסינון הנוכחי לייצוא.', 'error');
        return;
      }
      const filename = incidentsExportFilename(kind, filters.createdFrom, filters.createdTo);
      if (kind === 'csv') {
        downloadBlob(new Blob([incidentsToCsv(rows, ctx)], { type: 'text/csv;charset=utf-8' }), filename);
      } else {
        downloadBlob(incidentsToXlsxBlob(rows, ctx), filename);
      }
    },
    { successText: 'הייצוא הופק בהצלחה.', invalidate: [['audit']] },
  );

  const pageItems = useMemo(() => {
    const all = incidents ?? [];
    const start = (page - 1) * PAGE_SIZE;
    return { total: all.length, rows: all.slice(start, start + PAGE_SIZE) };
  }, [incidents, page]);

  const systemName = (id: string) => systems?.find((s) => s.id === id)?.name ?? '—';
  const locationName = (id: string) => locations?.find((l) => l.id === id)?.name ?? '—';

  const setFilters = (next: FilterState) => {
    // A single atomic update: calling url.set() once per key here would have
    // each call compute its diff against the same not-yet-committed snapshot,
    // so only the last call would ever actually stick (this was the root
    // cause of severity/owner/etc. filters silently failing to apply).
    url.setMany({
      q: next.search,
      status: next.status,
      severity: next.severity,
      owner: next.ownerUserId,
      system: next.systemId,
      location: next.locationId,
      overdue: next.overdueOnly ? '1' : undefined,
      ops: next.reportedToOps,
      page: undefined,
    });
  };

  const toggleSelect = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (isLoading) return <Spinner label="טוען תקלות…" />;
  if (isError) return <ErrorState message="שגיאה בטעינת רשימת התקלות." onRetry={() => refetch()} />;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="page-title">תקלות</h1>
        <div className="flex items-center gap-2">
          <Select
            aria-label="מיון"
            value={sort}
            onChange={(e) => url.set('sort', e.target.value)}
            className="w-auto"
          >
            <option value="priority">מיון לפי עדיפות</option>
            <option value="newest">החדשות ביותר</option>
            <option value="oldest">הישנות ביותר</option>
            <option value="next_update">לפי צפי עדכון</option>
            <option value="last_update">לפי עדכון אחרון</option>
          </Select>
          {canExport && (
            <>
              <Button variant="secondary" onClick={() => exportMutation.mutate('xlsx')}>
                ייצוא XLSX
              </Button>
              <Button variant="secondary" onClick={() => exportMutation.mutate('csv')}>
                ייצוא CSV
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mt-3">
        <IncidentFilterBar
          value={filters}
          onChange={setFilters}
          profiles={profiles}
          systems={systems}
          locations={locations}
          statusOptions={ACTIVE_STATUS_OPTIONS}
        />
      </div>

      <p className="mt-3 text-sm text-muted">
        {pageItems.total} תקלות תואמות
        {selected.size > 0 && ` · ${selected.size} נבחרו`}
      </p>

      {pageItems.rows.length === 0 ? (
        <div className="mt-4">
          <EmptyState title="לא נמצאו תקלות התואמות לסינון" subtitle="ניתן לנקות סינונים או לשנות את החיפוש." />
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {pageItems.rows.map((incident: Incident) => (
            <div key={incident.id} className="flex items-start gap-2">
              {canExport && (
                <input
                  type="checkbox"
                  className="mt-4 size-5"
                  aria-label={`בחירת תקלה ${incident.number} לייצוא`}
                  checked={selected.has(incident.id)}
                  onChange={() => toggleSelect(incident.id)}
                />
              )}
              <div className="flex-1">
                <IncidentCard
                  incident={incident}
                  profiles={profiles}
                  systemName={systemName(incident.systemId)}
                  locationName={locationName(incident.locationId)}
                  now={now}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {pageItems.total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <Button variant="secondary" disabled={page <= 1} onClick={() => url.set('page', String(page - 1))}>
            הקודם
          </Button>
          <span className="text-sm text-muted">
            עמוד {page} מתוך {Math.ceil(pageItems.total / PAGE_SIZE)}
          </span>
          <Button
            variant="secondary"
            disabled={page >= Math.ceil(pageItems.total / PAGE_SIZE)}
            onClick={() => url.set('page', String(page + 1))}
          >
            הבא
          </Button>
        </div>
      )}
    </div>
  );
}
