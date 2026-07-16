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
  return (
    <Link
      to={`/incidents/${incident.id}`}
      className={`surface-interactive group relative block p-3.5 pe-8 ${
        overdue ? 'border-s-4 border-s-red-500 bg-red-50/40 dark:border-s-red-500 dark:bg-red-950/20' : ''
      }`}
    >
      <IconChevronLeft className="absolute inset-y-0 end-2.5 my-auto size-4 text-muted opacity-0 transition-[opacity,transform] group-hover:-translate-x-0.5 group-hover:opacity-100" />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-extrabold text-brand-700 dark:text-brand-400">{incident.number}</span>
        <span className="font-semibold text-text-primary">{systemName}</span>
        <span className="text-sm text-muted">{locationName}</span>
        <span className="ms-auto flex gap-1.5">
          <SeverityBadge severity={incident.severity} />
          <StatusBadge status={incident.status} />
        </span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm text-secondary">{incident.operationalImpact}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="text-secondary">
          גורם מטפל: <span className="font-medium text-text-primary">{ownerDisplay(incident, profiles)}</span>
        </span>
        <span className="text-muted">עדכון אחרון: {formatRelative(incident.lastUpdateAt, now)}</span>
        <NextUpdateNote incident={incident} now={now} />
      </div>
      {incident.followUpRequired && !incident.followUpCompletedAt && (
        <p className="mt-2 text-sm font-medium text-orange-700 dark:text-orange-400">
          נדרשות פעולות המשך — כשירות לא מלאה
        </p>
      )}
    </Link>
  );
}
