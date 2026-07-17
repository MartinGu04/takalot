import { Link } from 'react-router-dom';
import type { Incident, Profile } from '../domain/types';
import { severityLabels, statusLabels } from '../domain/labels';
import { ownerDisplay } from './incident';
import { Dialog } from './ui';

const severityValueColor: Record<Incident['severity'], string> = {
  critical: 'text-red-700 dark:text-red-400',
  high: 'text-orange-700 dark:text-orange-400',
  medium: 'text-text-primary',
  low: 'text-text-primary',
};

/** Concise, clickable summary of every open incident — no description or timeline. */
export function OpenIncidentsSummary({
  open,
  onClose,
  incidents,
  profiles,
  systemName,
}: {
  open: boolean;
  onClose: () => void;
  incidents: Incident[];
  profiles: Profile[] | undefined;
  systemName: (id: string) => string;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={`תקלות פתוחות (${incidents.length})`} wide>
      <div className="-mx-1 flex max-h-[60dvh] flex-col gap-1 overflow-y-auto px-1">
        {incidents.map((incident) => {
          const hasOwner = !!(incident.ownerUserId || incident.ownerExternalName);
          return (
            <Link
              key={incident.id}
              to={`/incidents/${incident.id}`}
              onClick={onClose}
              className="rounded-lg p-2.5 transition-colors hover:bg-surface-hover"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-bold text-brand-700 dark:text-brand-400">{incident.number}</span>
                <span className="text-sm font-medium text-text-primary">{systemName(incident.systemId)}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-secondary">
                <span>
                  חומרה: <span className={`font-semibold ${severityValueColor[incident.severity]}`}>{severityLabels[incident.severity]}</span>
                </span>
                <span>
                  סטטוס נוכחי: <span className="font-semibold text-text-primary">{statusLabels[incident.status]}</span>
                </span>
                <span>
                  גורם מטפל:{' '}
                  <span className="font-semibold text-text-primary">
                    {hasOwner ? ownerDisplay(incident, profiles) : 'אין'}
                  </span>
                </span>
              </div>
            </Link>
          );
        })}
      </div>
      <div className="mt-3 border-t border-hairline pt-3 text-center">
        <Link
          to="/incidents"
          onClick={onClose}
          className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
        >
          לכל התקלות הפתוחות
        </Link>
      </div>
    </Dialog>
  );
}
