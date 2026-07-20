// Incident-related shared components.
import { Link } from 'react-router-dom';
import type { Incident, IncidentStatus, Profile, Severity } from '../domain/types';
import { severityLabels, statusLabels, readinessLabels } from '../domain/labels';
import { isOverdue, overdueText } from '../domain/overdue';
import { formatDateTime, formatRelative } from '../lib/time';
import { Badge } from './ui';
import { IconChevronLeft } from './icons';

export function SeverityBadge({ severity }: { severity: Severity }) {
  const color = severity === 'critical' ? 'red' : severity === 'high' ? 'orange' : 'neutral';
  return <Badge color={color}>{severityLabels[severity]}</Badge>;
}

const statusColor: Record<IncidentStatus, 'red' | 'orange' | 'green' | 'blue' | 'neutral'> = {
  new: 'blue',
  acknowledged: 'blue',
  in_progress: 'blue',
  waiting_external: 'orange',
  waiting_test: 'orange',
  monitoring: 'neutral',
  partial_readiness: 'orange',
  resolved_pending_close: 'orange',
  closed: 'green',
  reopened: 'blue',
};

export function StatusBadge({ status }: { status: IncidentStatus }) {
  return <Badge color={statusColor[status]}>{statusLabels[status]}</Badge>;
}

export function ReadinessBadge({ readiness }: { readiness: 'full' | 'partial' | 'none' }) {
  const color = readiness === 'full' ? 'green' : readiness === 'partial' ? 'orange' : 'red';
  return <Badge color={color}>כשירות: {readinessLabels[readiness]}</Badge>;
}

export function ownerDisplay(incident: Incident, profiles: Profile[] | undefined): string {
  if (incident.ownerUserId) {
    return profiles?.find((p) => p.id === incident.ownerUserId)?.fullName ?? 'משתמש פנימי';
  }
  return incident.ownerExternalName ? `${incident.ownerExternalName} (חיצוני)` : 'ללא גורם מטפל';
}

/** Next-update line: deadline, overdue phrase, or explicit "no deadline". */
export function NextUpdateNote({ incident, now }: { incident: Incident; now: Date }) {
  if (incident.status === 'closed') return null;
  if (!incident.nextUpdateDue) {
    return (
      <span className="text-sm text-muted">
        ללא צפי כרגע{incident.noDeadlineReason ? ` — ${incident.noDeadlineReason}` : ''}
      </span>
    );
  }
  if (isOverdue(incident, now)) {
    return (
      <span className="text-sm font-semibold text-red-700 dark:text-red-400">
        {overdueText(incident, now)}
      </span>
    );
  }
  return (
    <span className="text-sm text-secondary">
      עדכון הבא: {formatRelative(incident.nextUpdateDue, now)} ({formatDateTime(incident.nextUpdateDue)})
    </span>
  );
}

export function IncidentCard({
  incident,
  profiles,
  systemName,
  locationName,
  now,
}: {
  incident: Incident;
  profiles: Profile[] | undefined;
  systemName: string;
  locationName: string;
  now: Date;
}) {
  const overdue = isOverdue(incident, now);
  const accented = overdue || incident.severity === 'critical';
  const hasOwner = !!(incident.ownerUserId || incident.ownerExternalName);
  return (
    <Link
      to={`/incidents/${incident.id}`}
      className={`incident-card group ${accented ? 'incident-card-accent' : ''}`}
    >
      {/* Contextual "open" affordance -- purely decorative on top of the
          card-wide link, so it only needs to be visible on hover/focus, not
          reachable separately: the whole card is always the real, always-
          tappable action, on every input method. */}
      <IconChevronLeft className="absolute end-3 top-4 size-4 text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        {/* Main content: identity, description, severity, next-action state. */}
        <div className="min-w-0 flex-1 pe-6 sm:pe-8">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-extrabold text-brand-700 dark:text-brand-400">{incident.number}</span>
            <SeverityBadge severity={incident.severity} />
            <span className="min-w-0 break-words font-semibold text-text-primary">{systemName}</span>
            <span className="shrink-0 text-sm text-muted">{locationName}</span>
          </div>
          <p className="mt-1.5 line-clamp-2 break-words text-sm text-secondary">{incident.operationalImpact}</p>
          <div className="mt-2">
            <NextUpdateNote incident={incident} now={now} />
          </div>
          {incident.followUpRequired && !incident.followUpCompletedAt && (
            <p className="mt-2 text-sm font-medium text-orange-700 dark:text-orange-400">
              נדרשות פעולות המשך — כשירות לא מלאה
            </p>
          )}
        </div>

        {/* Metadata: a stable, vertically stacked column -- current status,
            handler, last-touched time -- instead of labels scattered across
            the full card width. */}
        <div className="flex shrink-0 flex-col items-start gap-1.5 sm:w-40 sm:items-end sm:border-s sm:border-hairline sm:ps-4 sm:text-end">
          <StatusBadge status={incident.status} />
          <span className="max-w-full truncate text-sm font-medium text-text-primary">
            {hasOwner ? ownerDisplay(incident, profiles) : 'ללא גורם מטפל'}
          </span>
          <span className="text-xs text-muted">עודכן {formatRelative(incident.lastUpdateAt, now)}</span>
        </div>
      </div>
    </Link>
  );
}
