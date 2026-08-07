// תקלות קשורות -- compact section on the incident detail page. Hidden
// entirely for a viewer without manage_incident_relations when there are no
// relations (never a large empty panel); a manage_incident_relations holder
// (אחמ״ש ומעלה) always sees the management entry point, even with zero
// relations, since it must never be the only thing an empty list hides.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { repo, useAppMutation } from '../data/hooks';
import { useSession } from '../auth/AuthContext';
import type { IncidentRelation } from '../domain/types';
import { SeverityBadge, StatusBadge } from './incident';
import { LinkRelatedIncidentDialog } from './LinkRelatedIncidentDialog';

export function RelatedIncidentsSection({
  incidentId,
  relations,
  canManage,
}: {
  incidentId: string;
  relations: IncidentRelation[] | undefined;
  canManage: boolean;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const session = useSession();
  const unlinkMutation = useAppMutation(
    (relatedIncidentId: string) => repo().manageIncidentRelation(session, incidentId, relatedIncidentId, 'unlink'),
    { successText: 'הקישור הוסר.' },
  );

  const list = relations ?? [];
  if (list.length === 0 && !canManage) return null;

  return (
    <section className="mt-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="section-title">תקלות קשורות</h2>
        {canManage && (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            קישור תקלה קשורה
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-muted">אין תקלות קשורות</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((r) => (
            <li key={r.id} className="surface flex items-center justify-between gap-2 p-2.5">
              <Link to={`/incidents/${r.relatedIncident.id}`} className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-bold text-brand-700 dark:text-brand-400">{r.relatedIncident.number}</span>
                  <SeverityBadge severity={r.relatedIncident.severity} />
                  <StatusBadge status={r.relatedIncident.status} />
                </div>
                <p className="mt-0.5 truncate text-xs text-secondary" dir="auto">
                  {r.relatedIncident.description}
                </p>
              </Link>
              {canManage && (
                <button
                  type="button"
                  disabled={unlinkMutation.isPending}
                  onClick={() => unlinkMutation.mutate(r.relatedIncident.id)}
                  aria-label={`הסרת קישור לתקלה ${r.relatedIncident.number}`}
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:text-red-400"
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <LinkRelatedIncidentDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          incidentId={incidentId}
          existingRelatedIds={list.map((r) => r.relatedIncident.id)}
        />
      )}
    </section>
  );
}
