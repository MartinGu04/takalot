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

const severityValueColor: Record<Severity, string> = {
  critical: 'text-red-700 dark:text-red-400',
  high: 'text-orange-700 dark:text-orange-400',
  medium: 'text-text-primary',
  low: 'text-text-primary',
};

/** Labeled "label: value" field — value emphasized, label kept secondary. */
function MetaField({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
  return (
    <div className="text-sm text-secondary">
      {label}: <span className={`font-semibold ${valueClassName ?? 'text-text-primary'}`}>{value}</span>
    </div>
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
  const hasOwner = !!(incident.ownerUserId || incident.ownerExternalName);
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
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm text-secondary">{incident.operationalImpact}</p>
      <div className="mt-2.5 grid grid-cols-1 gap-1 sm:grid-cols-3 sm:gap-3">
        <MetaField label="חומרה" value={severityLabels[incident.severity]} valueClassName={severityValueColor[incident.severity]} />
        <MetaField label="סטטוס נוכחי" value={statusLabels[incident.status]} />
        <MetaField label="גורם מטפל" value={hasOwner ? ownerDisplay(incident, profiles) : 'אין'} />
      </div>
      <p className="mt-2 text-xs text-muted">עדכון אחרון: {formatRelative(incident.lastUpdateAt, now)}</p>
      {incident.followUpRequired && !incident.followUpCompletedAt && (
        <p className="mt-2 text-sm font-medium text-orange-700 dark:text-orange-400">
          נדרשות פעולות המשך — כשירות לא מלאה
        </p>
      )}
    </Link>
  );
}
