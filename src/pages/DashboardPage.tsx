// "מצב נוכחי" — the operational picture at a glance.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useIncidents, useLocations, useProfiles, useSystems } from '../data/hooks';
import { useAuth } from '../auth/AuthContext';
import { isOverdue, sortByPriority } from '../domain/overdue';
import { isOpen, type Incident } from '../domain/types';
import { IncidentCard } from '../components/incident';
import { EmptyState, ErrorState, Spinner } from '../components/ui';
import { hasCapability } from '../domain/permissions';
import { IconAlertTriangle, IconClock, IconPulse } from '../components/icons';
import { OpenIncidentsSummary } from '../components/OpenIncidentsSummary';
import type { SVGProps } from 'react';

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

type StatTone = 'brand' | 'red' | 'orange';

const statToneStyles: Record<StatTone, { iconBg: string; iconColor: string; value: string }> = {
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

/** The single primary summary metric — visually larger than the secondary stats beside it, and clickable. */
function PrimaryStat({
  icon: Icon,
  label,
  value,
  onClick,
}: {
  icon: (props: SVGProps<SVGSVGElement>) => React.JSX.Element;
  label: string;
  value: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="surface-interactive flex min-w-0 items-center gap-4 p-4 text-right sm:p-5"
    >
      <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-400">
        <Icon className="size-7" />
      </span>
      <div className="min-w-0">
        <div className="text-4xl font-extrabold leading-tight text-text-primary">{value}</div>
        <div className="truncate text-sm font-medium text-secondary">{label}</div>
      </div>
    </button>
  );
}

/** A secondary, compact summary stat. */
function Stat({
  icon: Icon,
  label,
  value,
  tone = 'brand',
}: {
  icon: (props: SVGProps<SVGSVGElement>) => React.JSX.Element;
  label: string;
  value: number;
  tone?: StatTone;
}) {
  const t = statToneStyles[value > 0 ? tone : 'brand'];
  return (
    <div className="surface flex min-w-0 items-center gap-2.5 p-3">
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${t.iconBg} ${t.iconColor}`}>
        <Icon className="size-4.5" />
      </span>
      <div className="min-w-0">
        <div className={`text-xl font-extrabold leading-tight ${t.value}`}>{value}</div>
        <div className="truncate text-xs font-medium text-muted">{label}</div>
      </div>
    </div>
  );
}

function Section({
  title,
  incidents,
  children,
}: {
  title: string;
  incidents: Incident[];
  children: (incident: Incident) => React.ReactNode;
}) {
  if (incidents.length === 0) return null;
  return (
    <section className="mt-6">
      <h2 className="section-title mb-2">{title}</h2>
      <div className="flex flex-col gap-2">{incidents.map((i) => children(i))}</div>
    </section>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { data: incidents, isLoading, isError, refetch } = useIncidents({}, 'priority');
  const { data: profiles } = useProfiles();
  const { data: systems } = useSystems();
  const { data: locations } = useLocations();
  const [openSummaryOpen, setOpenSummaryOpen] = useState(false);
  const now = new Date();

  const derived = useMemo(() => {
    const all = incidents ?? [];
    const open = all.filter((i) => isOpen(i.status));
    const overdue = open.filter((i) => isOverdue(i, now));
    const critical = open.filter((i) => i.severity === 'critical' || i.severity === 'high');
    const needsAttention = sortByPriority(
      open.filter((i) => (i.severity === 'critical' || i.severity === 'high') && isOverdue(i, now)),
      now,
    );
    const overdueRest = sortByPriority(
      overdue.filter((i) => !needsAttention.includes(i)),
      now,
    );
    const inProgress = sortByPriority(
      open.filter((i) => !isOverdue(i, now) && ['new', 'acknowledged', 'in_progress', 'reopened'].includes(i.status)),
      now,
    );
    const waiting = sortByPriority(
      open.filter(
        (i) =>
          !isOverdue(i, now) &&
          ['waiting_external', 'waiting_test', 'monitoring', 'partial_readiness', 'resolved_pending_close'].includes(i.status),
      ),
      now,
    );
    const recentlyClosed = all
      .filter((i) => i.status === 'closed')
      .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
      .slice(0, 5);
    return { open, overdue, critical, needsAttention, overdueRest, inProgress, waiting, recentlyClosed };
  }, [incidents, now.getTime()]);

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

      <div className="mt-4 flex flex-col gap-2.5 sm:grid sm:grid-cols-[4fr_3fr_3fr]">
        <PrimaryStat
          icon={IconPulse}
          label="תקלות פתוחות"
          value={derived.open.length}
          onClick={() => setOpenSummaryOpen(true)}
        />
        <div className="grid grid-cols-2 gap-2.5 sm:contents">
          <Stat icon={IconAlertTriangle} label="קריטיות / גבוהות" value={derived.critical.length} tone="red" />
          <Stat icon={IconClock} label="עדכונים באיחור" value={derived.overdue.length} tone="red" />
        </div>
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

      <Section title="דורש טיפול עכשיו" incidents={derived.needsAttention}>{card}</Section>
      <Section title="עדכונים באיחור" incidents={derived.overdueRest}>{card}</Section>
      <Section title="בטיפול" incidents={derived.inProgress}>{card}</Section>
      <Section title="ממתינות / במעקב" incidents={derived.waiting}>{card}</Section>

      {derived.recentlyClosed.length > 0 && (
        <section className="mt-8">
          <h2 className="group-title mb-2">נסגרו לאחרונה</h2>
          <ul className="flex flex-col gap-1">
            {derived.recentlyClosed.map((i) => (
              <li key={i.id} className="text-sm">
                <Link to={`/incidents/${i.id}`} className="text-brand-700 hover:underline dark:text-brand-400">
                  {i.number}
                </Link>{' '}
                <span className="text-secondary">
                  {systemName(i.systemId)} — נסגרה
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <OpenIncidentsSummary
        open={openSummaryOpen}
        onClose={() => setOpenSummaryOpen(false)}
        incidents={derived.open}
        profiles={profiles}
        systemName={systemName}
      />
    </div>
  );
}
