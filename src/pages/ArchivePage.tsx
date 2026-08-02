// Archive: terminal incidents only -- closed AND cancelled. Search, filters,
// readiness, root-cause/solution text search, and export. No deletion action
// anywhere on this page.
import { useIncidents, useLocations, useProfiles, useSystems, useCanExport, useAppMutation, repo } from '../data/hooks';
import { useSession } from '../auth/AuthContext';
import { IncidentCard } from '../components/incident';
import { EmptyState, ErrorState, Input, Select, Spinner, useToast } from '../components/ui';
import { ExportMenu } from '../components/ExportMenu';
import { ArchiveDateFilter } from '../components/ArchiveDateFilter';
import { useUrlState } from '../lib/useUrlState';
import { useDebouncedField } from '../lib/useDebouncedField';
import { incidentsExportFilename, incidentsToCsv, incidentsToXlsxBlob, downloadBlob } from '../exports/table';
import { readinessLabels } from '../domain/labels';
import type { Readiness } from '../domain/types';

export default function ArchivePage() {
  const url = useUrlState();
  const search = url.get('q') ?? '';
  const rootCauseText = url.get('rootCause') ?? '';
  const resolutionText = url.get('resolution') ?? '';
  const readiness = url.get('readiness') as Readiness | undefined;
  // Terminal outcome. The archive's default scope is both outcomes; 'closed'
  // and 'cancelled' narrow it to one. Reached from the dashboard's closed
  // counter and "לכל הארכיון" link, and clearable here like any other filter.
  const outcomeParam = url.get('outcome');
  const outcome = outcomeParam === 'closed' || outcomeParam === 'cancelled' ? outcomeParam : undefined;
  const createdFrom = url.get('from');
  const createdTo = url.get('to');
  const session = useSession();
  const toast = useToast();

  // Debounced local drafts: typing must never be interrupted by the
  // URL/query round-trip that committing a filter value triggers.
  const [searchDraft, setSearchDraft] = useDebouncedField(search, (next) => url.set('q', next));
  const [rootCauseDraft, setRootCauseDraft] = useDebouncedField(rootCauseText, (next) =>
    url.set('rootCause', next),
  );
  const [resolutionDraft, setResolutionDraft] = useDebouncedField(resolutionText, (next) =>
    url.set('resolution', next),
  );

  const { data: incidents, isLoading, isError, refetch } = useIncidents(
    {
      terminalOnly: true,
      status: outcome ? [outcome] : undefined,
      search,
      rootCauseText: rootCauseText || undefined,
      resolutionText: resolutionText || undefined,
      readinessAtClose: readiness ? [readiness] : undefined,
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
        filtersDescription: `ארכיון: ${JSON.stringify({ search, readiness, createdFrom, createdTo })}`,
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

      <div className="surface mt-3 flex flex-col gap-3 p-3">
        <Input
          placeholder="חיפוש לפי מספר, מערכת, מיקום, תיאור, סיבת התקלה או הפתרון שבוצע…"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          aria-label="חיפוש בארכיון"
        />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Select
            aria-label="סינון לפי תוצאה"
            className="min-w-0"
            value={outcome ?? ''}
            onChange={(e) => url.set('outcome', e.target.value || undefined)}
          >
            <option value="">סגורות ומבוטלות</option>
            <option value="closed">סגורות בלבד</option>
            <option value="cancelled">מבוטלות בלבד</option>
          </Select>
          <Select
            aria-label="סינון לפי כשירות בסגירה"
            className="min-w-0"
            value={readiness ?? ''}
            onChange={(e) => url.set('readiness', e.target.value || undefined)}
          >
            <option value="">כשירות בסגירה…</option>
            {Object.entries(readinessLabels).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </Select>
          <Input
            className="min-w-0"
            placeholder="חיפוש בסיבת התקלה…"
            value={rootCauseDraft}
            onChange={(e) => setRootCauseDraft(e.target.value)}
          />
          <Input
            className="min-w-0"
            placeholder="חיפוש בפתרון שבוצע…"
            value={resolutionDraft}
            onChange={(e) => setResolutionDraft(e.target.value)}
          />
          <div className="min-w-0">
            <ArchiveDateFilter
              from={createdFrom}
              to={createdTo}
              onApply={(nextFrom, nextTo) => url.setMany({ from: nextFrom, to: nextTo })}
              onClear={() => url.setMany({ from: undefined, to: undefined })}
            />
          </div>
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
