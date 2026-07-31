// Reusable incident-list popup, shared by every KPI card on the dashboard
// (open / critical-or-high / overdue): one implementation, one filtering
// contract (a plain Incident[] the caller already derived from
// dashboardSummary/overdue -- this component never re-filters anything
// itself), one accessible dialog behavior (Dialog already provides focus
// trap, Escape-to-close, and a labelled close button).
import { Link } from 'react-router-dom';
import type { Incident, Profile } from '../domain/types';
import { severityLabels } from '../domain/labels';
import { StatusBadge, ownerDisplay } from './incident';
import { Dialog } from './ui';

const severityValueColor: Record<Incident['severity'], string> = {
  critical: 'text-red-700 dark:text-red-400',
  high: 'text-orange-700 dark:text-orange-400',
  medium: 'text-text-primary',
  low: 'text-text-primary',
};

export function IncidentListDialog({
  open,
  onClose,
  titleBase,
  incidents,
  profiles,
  systemName,
  locationName,
  emptyMessage,
  viewAllHref,
  viewAllLabel = 'לכל הרשימה המלאה',
}: {
  open: boolean;
  onClose: () => void;
  /** Dialog title without the count -- the count is appended automatically. */
  titleBase: string;
  incidents: Incident[];
  profiles: Profile[] | undefined;
  systemName: (id: string) => string;
  locationName: (id: string) => string;
  emptyMessage: string;
  /** Optional deep link (reusing IncidentsPage's own query-param filters) to
   *  the full, unbounded list this popup summarizes. Omitted when there's no
   *  equivalent filtered view. */
  viewAllHref?: string;
  viewAllLabel?: string;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={`${titleBase} (${incidents.length})`} wide>
      {incidents.length === 0 ? (
        <p className="py-8 text-center text-sm text-secondary">{emptyMessage}</p>
      ) : (
        <div className="-mx-1 flex max-h-[60dvh] flex-col gap-1 overflow-y-auto px-1">
          {incidents.map((incident) => {
            return (
              <Link
                key={incident.id}
                to={`/incidents/${incident.id}`}
                onClick={onClose}
                className="rounded-lg p-2.5 transition-colors hover:bg-surface-hover"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-bold text-brand-700 dark:text-brand-400">{incident.number}</span>
                  <StatusBadge status={incident.status} />
                  <span className="text-sm font-medium text-text-primary">
                    {systemName(incident.systemId)} · {locationName(incident.locationId)}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-secondary">
                  <span>
                    חומרה:{' '}
                    <span className={`font-semibold ${severityValueColor[incident.severity]}`}>
                      {severityLabels[incident.severity]}
                    </span>
                  </span>
                  <span>
                    בעל אחריות פנימי:{' '}
                    <span className="font-semibold text-text-primary">
                      {ownerDisplay(incident, profiles)}
                    </span>
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      {viewAllHref && (
        <div className="mt-3 border-t border-hairline pt-3 text-center">
          <Link
            to={viewAllHref}
            onClick={onClose}
            className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            {viewAllLabel}
          </Link>
        </div>
      )}
    </Dialog>
  );
}
