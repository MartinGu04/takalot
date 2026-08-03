// Archive: terminal incidents only -- closed AND cancelled. Search, filters
// (outcome, system, assignee, date range), and export. No deletion action
// anywhere on this page.
import { useIncidents, useLocations, useProfiles, useSystems, useCanExport, useAppMutation, repo } from '../data/hooks';
import { useSession } from '../auth/AuthContext';
import { IncidentCard } from '../components/incident';
import { EmptyState, ErrorState, Input, Select, Spinner, useToast, filterFieldClass, filterControlClass } from '../components/ui';
import { SystemOptions, EligibleOwnerOptions } from '../components/ReferenceDataOptions';
import { ExportMenu } from '../components/ExportMenu';
import { ArchiveDateFilter } from '../components/ArchiveDateFilter';
import { useUrlState } from '../lib/useUrlState';
import { useDebouncedField } from '../lib/useDebouncedField';
import { incidentsExportFilename, incidentsToCsv, incidentsToXlsxBlob, downloadBlob } from '../exports/table';

export default function ArchivePage() {
  const url = useUrlState();
  // The general search already covers root cause and resolution text (see
  // the placeholder below and the repositories' search implementation), so
  // there is no separate dedicated field for either.
  const search = url.get('q') ?? '';
  const systemId = url.get('system');
  const ownerUserId = url.get('owner');
  // Terminal outcome. The archive's default scope is both outcomes; 'closed'
  // and 'cancelled' narrow it to one. Reached from the dashboard's closed
  // counter and "לכל הארכיון" link, and clearable here like any other filter.
  const outcomeParam = url.get('outcome');
  const outcome = outcomeParam === 'closed' || outcomeParam === 'cancelled' ? outcomeParam : undefined;
  const createdFrom = url.get('from');
  const createdTo = url.get('to');
  const session = useSession();
  const toast = useToast();

  // Debounced local draft: typing must never be interrupted by the
  // URL/query round-trip that committing a filter value triggers.
  const [searchDraft, setSearchDraft] = useDebouncedField(search, (next) => url.set('q', next));

  const { data: incidents, isLoading, isError, refetch } = useIncidents(
    {
      terminalOnly: true,
      status: outcome ? [outcome] : undefined,
      search,
      systemId: systemId || undefined,
      ownerUserId: ownerUserId || undefined,
      createdFrom: createdFrom ? new Date(createdFrom).toISOString() : undefined,
      createdTo: createdTo ? new Date(createdTo + 'T23:59:59').toISOString() : undefined,
    },
    'newest',
  );
  const { data: profiles } = useProfiles();
  const { data: systems } = useSystems();
  const { data: locations } = useLocations();
  const { data: canExport } = useCanExport();
  const now = new Date();

  const exportMutation = useAppMutation(
    async (kind: 'xlsx' | 'csv') => {
      const ctx = { profiles: profiles ?? [], systems: systems ?? [], locations: locations ?? [], now };
      await repo().recordExport(session, {
        exportType: kind === 'xlsx' ? 'incidents_xlsx' : 'incidents_csv',
        filtersDescription: `ארכיון: ${JSON.stringify({ search, systemId, ownerUserId, createdFrom, createdTo })}`,
      });
      const rows = incidents ?? [];
      if (rows.length === 0) {
        toast('אין שורות התואמות לסינון הנוכחי לייצוא.', 'error');
        return;
      }
      const filename = incidentsExportFilename(
        kind,
        createdFrom ? new Date(createdFrom).toISOString() : undefined,
        createdTo ? new Date(createdTo).toISOString() : undefined,
      );
      if (kind === 'csv') downloadBlob(new Blob([incidentsToCsv(rows, ctx)], { type: 'text/csv;charset=utf-8' }), filename);
      else downloadBlob(incidentsToXlsxBlob(rows, ctx), filename);
    },
    { successText: 'הייצוא הופק בהצלחה.', invalidate: [['audit']] },
  );

  const systemName = (id: string) => systems?.find((s) => s.id === id)?.name ?? '—';
  const locationName = (id: string) => locations?.find((l) => l.id === id)?.name ?? '—';

  if (isLoading) return <Spinner label="טוען ארכיון…" />;
  if (isError) return <ErrorState message="שגיאה בטעינת הארכיון." onRetry={() => refetch()} />;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="page-title">ארכיון תקלות סגורות ומבוטלות</h1>
        {canExport && (
          <ExportMenu
            disabled={exportMutation.isPending}
            options={[
              { kind: 'xlsx', label: 'ייצוא XLSX' },
              { kind: 'csv', label: 'ייצוא CSV' },
            ]}
            onExport={(kind) => exportMutation.mutate(kind as 'xlsx' | 'csv')}
          />
        )}
      </div>

      <div className="surface mt-2 flex flex-col gap-2 p-2">
        <Input
          className={filterFieldClass}
          placeholder="חיפוש לפי מספר, מערכת, מיקום, תיאור, סיבת התקלה או הפתרון שבוצע…"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          aria-label="חיפוש בארכיון"
        />
        {/* Desktop: one compact row of four equal columns, right-to-left as
            תוצאה -> מערכת -> גורם מטפל -> תאריך. A real grid (not flex +
            shrink-to-content) so each control reliably fills its own column
            instead of the browser resolving a `w-full`/`w-auto` conflict on
            its own -- two columns on tablet, one on mobile. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            aria-label="סינון לפי תוצאה"
            className={filterControlClass}
            value={outcome ?? ''}
            onChange={(e) => url.set('outcome', e.target.value || undefined)}
          >
            <option value="">סגורות ומבוטלות</option>
            <option value="closed">סגורות בלבד</option>
            <option value="cancelled">מבוטלות בלבד</option>
          </Select>
          <Select
            aria-label="סינון לפי מערכת"
            className={filterControlClass}
            value={systemId ?? ''}
            onChange={(e) => url.set('system', e.target.value || undefined)}
          >
            <option value="">כל המערכות</option>
            {/* Includes archived systems (listSystems returns the full set,
                unfiltered) -- an archived incident may reference a system
                that's since been archived/deactivated, and that historical
                incident must still be findable. Same "(בארכיון)" suffix
                convention IncidentFilterBar already uses for the same
                reason, rather than a new visual treatment. */}
            <SystemOptions systems={systems} includeArchived />
          </Select>
          <Select
            aria-label="סינון לפי גורם מטפל"
            className={filterControlClass}
            value={ownerUserId ?? ''}
            onChange={(e) => url.set('owner', e.target.value || undefined)}
          >
            <option value="">כל הגורמים המטפלים</option>
            <EligibleOwnerOptions profiles={profiles} />
          </Select>
          <ArchiveDateFilter
            from={createdFrom}
            to={createdTo}
            onApply={(nextFrom, nextTo) => url.setMany({ from: nextFrom, to: nextTo })}
            onClear={() => url.setMany({ from: undefined, to: undefined })}
          />
        </div>
      </div>

      <p className="mt-3 text-sm text-muted">{(incidents ?? []).length} תקלות בארכיון תואמות</p>

      {(incidents ?? []).length === 0 ? (
        <div className="mt-4">
          <EmptyState title="לא נמצאו תקלות בארכיון התואמות לסינון" />
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {(incidents ?? []).map((incident) => (
            <IncidentCard
              key={incident.id}
              incident={incident}
              profiles={profiles}
              systemName={systemName(incident.systemId)}
              locationName={locationName(incident.locationId)}
              now={now}
            />
          ))}
        </div>
      )}
    </div>
  );
}
