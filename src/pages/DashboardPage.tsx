// "מצב נוכחי" — the operational picture at a glance.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useClosedIncidentCount, useIncidents, useLocations, useProfiles, useSystems } from '../data/hooks';
import { useAuth } from '../auth/AuthContext';
import { summarizeDashboard, terminalAt } from '../domain/dashboardSummary';
import type { Incident } from '../domain/types';
import { IncidentCard, StatusBadge } from '../components/incident';
import { EmptyState, ErrorState, Spinner } from '../components/ui';
import { hasCapability } from '../domain/permissions';
import { IconAlertTriangle, IconClock, IconPulse } from '../components/icons';
import { IncidentListDialog } from '../components/IncidentListDialog';
import { formatDateTime, formatRelative } from '../lib/time';
import type { SVGProps } from 'react';

/** The archive, pre-filtered to the closed outcome only (never cancelled). */
export const CLOSED_ARCHIVE_HREF = '/archive?outcome=closed';

function summarySentence(open: Incident[], overdue: Incident[]): string {
  if (open.length === 0) return 'כרגע אין תקלות פתוחות.';
  const critical = open.filter((i) => i.severity === 'critical').length;
  const parts: string[] = [];
  parts.push(open.length === 1 ? 'כרגע פתוחה תקלה אחת' : `כרגע פתוחות ${open.length} תקלות`);
  if (critical === 1) parts.push('אחת קריטית');
  else if (critical > 1) parts.push(`${critical} קריטיות`);
  if (overdue.length === 1) parts.push('תקלה אחת ממתינה לעדכון באיחור');
  else if (overdue.length > 1) parts.push(`${overdue.length} תקלות ממתינות לעדכון באיחור`);
  return parts.join('. ') + '.';
}

type KpiTone = 'brand' | 'red' | 'orange';

const kpiToneStyles: Record<KpiTone, { iconBg: string; iconColor: string; value: string }> = {
  brand: {
    iconBg: 'bg-brand-50 dark:bg-brand-950/60',
    iconColor: 'text-brand-600 dark:text-brand-400',
    value: 'text-text-primary',
  },
  red: {
    iconBg: 'bg-red-50 dark:bg-red-950/60',
    iconColor: 'text-red-600 dark:text-red-400',
    value: 'text-red-700 dark:text-red-400',
  },
  orange: {
    iconBg: 'bg-orange-50 dark:bg-orange-950/60',
    iconColor: 'text-orange-600 dark:text-orange-400',
    value: 'text-orange-700 dark:text-orange-400',
  },
};

/** A permanent, subtle 1px border per KPI card identity -- brand/purple for
 *  open, red for critical/high, yellow for overdue. Unlike the icon/value
 *  color above (which dims to neutral once its count is zero, so an empty
 *  dashboard never looks alarming), this border is a calm category marker,
 *  not an urgency signal, so it stays constant regardless of count. Same
 *  restrained shade already used by Badge -- no new color introduced, no
 *  glow, no gradient. */
const kpiBorderStyles: Record<KpiTone, string> = {
  brand: 'border-brand-200 dark:border-brand-800',
  red: 'border-red-200 dark:border-red-800',
  orange: 'border-yellow-300 dark:border-yellow-700',
};

/**
 * A single KPI card shape shared by all three top-of-page metrics -- equal
 * dimensions, equally interactive (opens the matching IncidentListDialog),
 * restrained color (a tone only reads as red/orange once its count is
 * actually above zero; at zero every card reads as calm/neutral so an empty
 * dashboard never looks alarming). The label and context line are never
 * truncated -- these are operational facts, not decoration, and must stay
 * fully readable at every supported width.
 */
function KpiCard({
  icon: Icon,
  label,
  value,
  context,
  tone = 'brand',
  onClick,
}: {
  icon: (props: SVGProps<SVGSVGElement>) => React.JSX.Element;
  label: string;
  value: number;
  context: string;
  tone?: KpiTone;
  onClick: () => void;
}) {
  const t = kpiToneStyles[value > 0 ? tone : 'brand'];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}: ${value}. ${context}. לחיצה להצגת הרשימה.`}
      className={`surface-interactive flex min-w-0 flex-col gap-3 p-4 text-right sm:p-5 ${kpiBorderStyles[tone]}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${t.iconBg} ${t.iconColor}`}>
          <Icon className="size-5.5" />
        </span>
        <div className={`text-3xl font-extrabold leading-none ${t.value} sm:text-4xl`}>{value}</div>
      </div>
      <div className="min-w-0">
        {/* Deliberately no truncate: "עדכונים באיחור" / "קריטיות / גבוהות" /
            "תקלות פתוחות" must wrap to two lines on narrow screens rather
            than lose text to an ellipsis -- these are operational labels,
            not decoration. */}
        <div className="text-sm font-bold leading-snug text-text-primary">{label}</div>
        <div className="mt-0.5 text-xs leading-snug text-muted">{context}</div>
      </div>
    </button>
  );
}

function Section({
  title,
  incidents,
  emptyState,
  children,
}: {
  title: string;
  incidents: Incident[];
  emptyState?: React.ReactNode;
  children: (incident: Incident) => React.ReactNode;
}) {
  if (incidents.length === 0 && !emptyState) return null;
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="section-title">{title}</h2>
        <span className="text-sm font-medium text-muted">({incidents.length})</span>
      </div>
      {incidents.length === 0 ? emptyState : <div className="flex flex-col gap-2">{incidents.map((i) => children(i))}</div>}
    </section>
  );
}

/** Compact row for "נסגרו לאחרונה" -- both closed and cancelled incidents,
 *  each labeled with its own status badge and the actual moment it reached
 *  that terminal state (never the generic "closed" text regardless of what
 *  actually happened). The whole row is the link, matching every other
 *  incident-list pattern in the app. */
function RecentTerminalRow({
  incident,
  systemName,
  locationName,
  now,
}: {
  incident: Incident;
  systemName: string;
  locationName: string;
  now: Date;
}) {
  const at = terminalAt(incident);
  const verb = incident.status === 'cancelled' ? 'בוטלה' : 'נסגרה';
  return (
    <Link
      to={`/incidents/${incident.id}`}
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2.5 py-2 transition-colors hover:bg-surface-hover"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusBadge status={incident.status} />
        <span className="font-bold text-brand-700 dark:text-brand-400">{incident.number}</span>
        <span className="text-sm text-secondary">
          {systemName} · {locationName}
        </span>
      </div>
      {at && (
        <span className="shrink-0 text-xs text-muted" title={formatDateTime(at)}>
          {verb} {formatRelative(at, now)}
        </span>
      )}
    </Link>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { data: incidents, isLoading, isError, refetch } = useIncidents({}, 'priority');
  const { data: closedCount } = useClosedIncidentCount();
  const { data: profiles } = useProfiles();
  const { data: systems } = useSystems();
  const { data: locations } = useLocations();
  const [activePopup, setActivePopup] = useState<'open' | 'criticalOrHigh' | 'overdue' | null>(null);
  const now = new Date();

  const derived = useMemo(() => summarizeDashboard(incidents ?? [], now), [incidents, now.getTime()]);

  if (isLoading) return <Spinner label="טוען את התמונה העדכנית…" />;
  if (isError)
    return <ErrorState message="שגיאה בטעינת הנתונים. בדקו את החיבור ונסו שוב." onRetry={() => refetch()} />;

  const systemName = (id: string) => systems?.find((s) => s.id === id)?.name ?? '—';
  const locationName = (id: string) => locations?.find((l) => l.id === id)?.name ?? '—';

  const card = (incident: Incident) => (
    <IncidentCard
      key={incident.id}
      incident={incident}
      profiles={profiles}
      systemName={systemName(incident.systemId)}
      locationName={locationName(incident.locationId)}
      now={now}
    />
  );

  return (
    <div>
      <h1 className="page-title">מצב נוכחי</h1>
      <p className="mt-1 text-secondary" data-testid="summary-sentence">
        {summarySentence(derived.open, derived.overdue)}
      </p>

      <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <KpiCard
          icon={IconPulse}
          label="תקלות פתוחות"
          value={derived.open.length}
          context="כל התקלות הפעילות כרגע"
          onClick={() => setActivePopup('open')}
        />
        <KpiCard
          icon={IconAlertTriangle}
          label="קריטיות / גבוהות"
          value={derived.criticalOrHigh.length}
          context="בחומרה קריטית או גבוהה"
          tone="red"
          onClick={() => setActivePopup('criticalOrHigh')}
        />
        <KpiCard
          icon={IconClock}
          label="עדכונים באיחור"
          value={derived.overdue.length}
          context="ממתינות לעדכון מעבר לזמן היעד"
          tone="orange"
          onClick={() => setActivePopup('overdue')}
        />
      </div>

      {derived.open.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title="אין תקלות פתוחות כרגע"
            subtitle={
              user && hasCapability(user.role, 'create_incident')
                ? 'אפשר לפתוח תקלה חדשה בכפתור "פתיחת תקלה".'
                : undefined
            }
          />
        </div>
      )}

      <Section
        title="דורש טיפול עכשיו"
        incidents={derived.needsAttention}
        emptyState={
          <div className="rounded-xl border border-hairline bg-surface/60 px-4 py-3 text-sm text-secondary">
            אין כרגע תקלות שדורשות טיפול מיידי.
          </div>
        }
      >
        {card}
      </Section>
      <Section title="תקלות פתוחות" incidents={derived.openRest}>{card}</Section>

      {derived.recentTerminal.length > 0 && (
        <section className="mt-8">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <h2 className="group-title">נסגרו לאחרונה</h2>
              {/* Total closed incidents -- not the (at most five) rows
                  rendered below, and never including cancelled ones. Kept to
                  a small neutral pill so the section's existing hierarchy is
                  unchanged: this is a quiet reference number, not a KPI. */}
              {typeof closedCount === 'number' && closedCount > 0 && (
                <Link
                  to={CLOSED_ARCHIVE_HREF}
                  data-testid="closed-total"
                  aria-label={`סך הכול ${closedCount} תקלות סגורות — מעבר לארכיון`}
                  className="rounded-full bg-surface-active px-2 py-0.5 text-xs font-semibold tabular-nums text-text-secondary hover:bg-surface-hover"
                >
                  {closedCount}
                </Link>
              )}
            </div>
            <Link
              to={CLOSED_ARCHIVE_HREF}
              className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
            >
              לכל הארכיון
            </Link>
          </div>
          <div className="surface flex flex-col divide-y divide-hairline p-1">
            {derived.recentTerminal.map((i) => (
              <RecentTerminalRow
                key={i.id}
                incident={i}
                systemName={systemName(i.systemId)}
                locationName={locationName(i.locationId)}
                now={now}
              />
            ))}
          </div>
        </section>
      )}

      <IncidentListDialog
        open={activePopup === 'open'}
        onClose={() => setActivePopup(null)}
        titleBase="תקלות פתוחות"
        incidents={derived.open}
        profiles={profiles}
        systemName={systemName}
        locationName={locationName}
        emptyMessage="אין תקלות פתוחות כרגע."
        viewAllHref="/incidents"
        viewAllLabel="לכל התקלות הפתוחות"
      />
      <IncidentListDialog
        open={activePopup === 'criticalOrHigh'}
        onClose={() => setActivePopup(null)}
        titleBase="תקלות קריטיות / גבוהות"
        incidents={derived.criticalOrHigh}
        profiles={profiles}
        systemName={systemName}
        locationName={locationName}
        emptyMessage="אין כרגע תקלות פתוחות בחומרה קריטית או גבוהה."
        viewAllHref="/incidents?severity=critical,high"
        viewAllLabel="לכל התקלות הקריטיות / גבוהות"
      />
      <IncidentListDialog
        open={activePopup === 'overdue'}
        onClose={() => setActivePopup(null)}
        titleBase="עדכונים באיחור"
        incidents={derived.overdue}
        profiles={profiles}
        systemName={systemName}
        locationName={locationName}
        emptyMessage="אין כרגע תקלות עם עדכון באיחור."
        viewAllHref="/incidents?overdue=1"
        viewAllLabel="לכל התקלות באיחור"
      />
    </div>
  );
}
