// Incident-related shared components.
import { Link } from 'react-router-dom';
import type { Incident, IncidentStatus, Profile, Severity } from '../domain/types';
import { severityLabels, statusLabels, readinessLabels } from '../domain/labels';
import { isOverdue, overdueText } from '../domain/overdue';
import { formatDateTime, formatRelative } from '../lib/time';
import { meaningfulNoDeadlineReason, NO_DEADLINE_LABEL } from '../domain/deadline';
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
  cancelled: 'neutral',
  waiting_equipment: 'orange',
  waiting_information: 'orange',
  waiting_validation: 'orange',
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
    const reason = meaningfulNoDeadlineReason(incident.noDeadlineReason);
    return (
      <span className="text-sm text-muted">
        {NO_DEADLINE_LABEL}{reason ? ` — ${reason}` : ''}
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
  const critical = incident.severity === 'critical';
  // Critical severity takes precedence over overdue -- an incident that is
  // both never gets a mixed or double treatment, just the critical (red) one.
  const accentClass = critical ? 'incident-card-accent-critical' : overdue ? 'incident-card-accent-overdue' : '';
  const hasOwner = !!(incident.ownerUserId || incident.ownerExternalName);
  return (
    <Link
      to={`/incidents/${incident.id}`}
      className={`incident-card group ${accentClass}`}
    >
      {/* Contextual "open" affordance -- purely decorative on top of the
          card-wide link, so it only needs to be visible on hover/focus, not
          reachable separately: the whole card is always the real, always-
          tappable action, on every input method. */}
      <IconChevronLeft className="absolute end-3 top-4 size-4 text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        {/* Main content: identity, description, severity, next-action state.
            Line 1: number + severity. Line 2: system/location (labeled).
            Then the description -- nothing scattered across the card width. */}
        <div className="min-w-0 flex-1 pe-6 sm:pe-8">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-extrabold text-brand-700 dark:text-brand-400">{incident.number}</span>
            <SeverityBadge severity={incident.severity} />
          </div>
          {/* Deliberately no truncate: system/location are identifying facts,
              not decoration -- they must wrap rather than lose text to an
              ellipsis on a narrow card. */}
          {/* Each free-text value carries its own dir="auto" rather than the
              row inheriting one direction for everything. The label around it
              ("מערכת:") is Hebrew and stays RTL, while a value like
              "Alta Systems (IAF)" resolves to LTR from its own first strong
              character -- so its parentheses and trailing punctuation land on
              the correct side instead of being reordered by the RTL page. A
              Hebrew or mixed value (e.g. "טיפול של אלתא (IAF)") resolves to
              RTL by the same rule and is unaffected. */}
          <p className="mt-1 break-words text-start text-sm text-muted">
            מערכת:{' '}
            <span dir="auto" className="font-medium text-text-secondary">
              {systemName}
            </span>
            {' · '}
            מיקום:{' '}
            <span dir="auto" className="font-medium text-text-secondary">
              {locationName}
            </span>
          </p>
          <p dir="auto" className="mt-1.5 line-clamp-2 break-words text-start text-sm text-secondary">
            {incident.operationalImpact}
          </p>
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
            the full card width.

            Alignment is logical-start throughout (right, under the page's
            RTL direction), matching the content column beside it rather than
            mirroring away from it: Hebrew metadata reads from the same edge
            as everything else on the card. The divider is the column's
            inline-start border (`border-s` + `ps-4`), which in RTL is its
            right edge -- the side that actually faces the content column --
            so it stays on the seam in either direction instead of drifting
            to the card's outer edge. */}
        <div className="flex shrink-0 flex-col items-start gap-1.5 text-start sm:w-48 sm:border-s sm:border-hairline sm:ps-4">
          <StatusBadge status={incident.status} />
          {/* dir="auto" so an external handler written in Latin script keeps
              its own direction; a Hebrew or mixed name such as
              "טיפול של אלתא (IAF)" resolves to RTL from its first strong
              character and renders its parentheses correctly. */}
          <span
            dir="auto"
            className="max-w-full truncate text-sm font-medium text-text-primary"
            title={hasOwner ? ownerDisplay(incident, profiles) : undefined}
          >
            {hasOwner ? ownerDisplay(incident, profiles) : 'ללא גורם מטפל'}
          </span>
          <span className="text-xs text-muted">עודכן {formatRelative(incident.lastUpdateAt, now)}</span>
        </div>
      </div>
    </Link>
  );
}
