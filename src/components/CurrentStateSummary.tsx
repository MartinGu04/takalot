// תמונת מצב עדכנית -- a compact, prominent summary of the incident's current
// operational state, placed before the full Timeline so it can be read
// without scrolling through it. Entirely derived from already-loaded
// incident/update/event data (see domain/currentState.ts) -- no new field,
// no new input, nothing to maintain separately.
import type { Incident, IncidentClosureClassification, IncidentEvent, IncidentUpdate, Profile } from '../domain/types';
import { selectCurrentStateSummary } from '../domain/currentState';
import { treatmentOutcomeLabels } from '../domain/labels';
import { RelativeTime } from './RelativeTime';

function profileName(id: string | null, profiles: Profile[] | undefined): string {
  if (!id) return 'לא ידוע';
  return profiles?.find((p) => p.id === id)?.fullName ?? 'משתמש';
}

export function CurrentStateSummary({
  incident,
  updates,
  events,
  closures,
  profiles,
}: {
  incident: Incident;
  updates: IncidentUpdate[];
  events: IncidentEvent[];
  closures: IncidentClosureClassification[] | undefined;
  profiles: Profile[] | undefined;
}) {
  const result = selectCurrentStateSummary(incident, updates, events, closures);

  const scrollToTimelineEntry = (anchorId: string) => {
    const el = document.getElementById(`timeline-entry-${anchorId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();
  };

  return (
    <section className="mt-4">
      <h2 className="section-title mb-2">תמונת מצב עדכנית</h2>

      {result.kind === 'active' && result.anchorId && (
        <button
          type="button"
          className="incident-card w-full p-3 text-start"
          onClick={() => scrollToTimelineEntry(result.anchorId!)}
        >
          <p className="whitespace-pre-wrap break-words text-sm text-text-primary">
            {result.update.currentStatusText}
          </p>
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-1 text-xs text-muted">
            <span>
              עודכן <RelativeTime iso={result.update.eventTime} />
            </span>
            <span>על ידי {profileName(result.update.authorId, profiles)}</span>
          </p>
        </button>
      )}

      {result.kind === 'active' && !result.anchorId && (
        <div className="surface p-3">
          <p className="whitespace-pre-wrap break-words text-sm text-text-primary">
            {result.update.currentStatusText}
          </p>
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-1 text-xs text-muted">
            <span>
              עודכן <RelativeTime iso={result.update.eventTime} />
            </span>
            <span>על ידי {profileName(result.update.authorId, profiles)}</span>
          </p>
        </div>
      )}

      {result.kind === 'no_update' && (
        <div className="surface p-3">
          <p className="text-sm text-text-secondary">טרם פורסם עדכון מצב</p>
        </div>
      )}

      {result.kind === 'no_update_since_reopen' && (
        <div className="surface p-3">
          <p className="text-sm text-text-secondary">טרם פורסם עדכון מצב מאז הפתיחה מחדש</p>
        </div>
      )}

      {result.kind === 'closed' && (
        <div className="surface p-3">
          <p className="text-sm font-bold text-text-primary">התקלה נסגרה</p>
          {incident.resolution && (
            <p className="mt-1 line-clamp-2 text-sm text-text-secondary" title={incident.resolution}>
              {incident.resolution}
            </p>
          )}
          {incident.closedAt && (
            <p className="mt-1.5 flex flex-wrap items-baseline gap-x-1 text-xs text-muted">
              <span>
                נסגרה <RelativeTime iso={incident.closedAt} />
              </span>
              <span>על ידי {profileName(incident.closedBy, profiles)}</span>
            </p>
          )}
          {result.closure && (
            <p className="mt-1 text-xs text-secondary">
              תוצאת הטיפול: {treatmentOutcomeLabels[result.closure.treatmentOutcome]}
              {result.closure.treatmentOutcome === 'other' && result.closure.treatmentOutcomeOtherDetail
                ? ` — ${result.closure.treatmentOutcomeOtherDetail}`
                : ''}
            </p>
          )}
        </div>
      )}

      {result.kind === 'cancelled' && (
        <div className="surface p-3">
          <p className="text-sm font-bold text-text-primary">התקלה בוטלה</p>
          {incident.cancellationReason && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-text-secondary">
              {incident.cancellationReason}
            </p>
          )}
          {incident.cancelledAt && (
            <p className="mt-1.5 flex flex-wrap items-baseline gap-x-1 text-xs text-muted">
              <span>
                בוטלה <RelativeTime iso={incident.cancelledAt} />
              </span>
              <span>על ידי {profileName(incident.cancelledBy, profiles)}</span>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
