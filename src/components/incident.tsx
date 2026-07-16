// Incident-related shared components.
import { Link } from 'react-router-dom';
import type { Incident, IncidentStatus, Profile, Severity } from '../domain/types';
import { severityLabels, statusLabels, readinessLabels } from '../domain/labels';
import { isOverdue, overdueText } from '../domain/overdue';
import { formatDateTime, formatRelative } from '../lib/time';
import { Badge } from './ui';

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
      <span className="text-sm text-neutral-500 dark:text-neutral-400">
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
    <span className="text-sm text-neutral-600 dark:text-neutral-300">
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
  action,
}: {
  incident: Incident;
  profiles: Profile[] | undefined;
  systemName: string;
  locationName: string;
  now: Date;
  action?: React.ReactNode;
}) {
  const overdue = isOverdue(incident, now);
  return (
    <div
      className={`rounded-xl border bg-white p-3 dark:bg-neutral-900 ${
        overdue
          ? 'border-red-300 dark:border-red-800'
          : 'border-neutral-200 dark:border-neutral-700'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to={`/incidents/${incident.id}`}
          className="font-bold text-blue-700 hover:underline dark:text-blue-400"
        >
          {incident.number}
        </Link>
        <span className="font-medium">{systemName}</span>
        <span className="text-sm text-neutral-500">{locationName}</span>
        <span className="ms-auto flex gap-1.5">
          <SeverityBadge severity={incident.severity} />
          <StatusBadge status={incident.status} />
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-sm text-neutral-700 dark:text-neutral-300">
        {incident.operationalImpact}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="text-neutral-600 dark:text-neutral-300">
          גורם מטפל: <strong>{ownerDisplay(incident, profiles)}</strong>
        </span>
        <span className="text-neutral-500">עדכון אחרון: {formatRelative(incident.lastUpdateAt, now)}</span>
        <NextUpdateNote incident={incident} now={now} />
      </div>
      {incident.followUpRequired && !incident.followUpCompletedAt && (
        <p className="mt-2 text-sm font-medium text-orange-700 dark:text-orange-400">
          נדרשות פעולות המשך — כשירות לא מלאה
        </p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
