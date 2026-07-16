// "מצב נוכחי" — the operational picture at a glance.
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useIncidents, useLocations, useProfiles, useSystems } from '../data/hooks';
import { useAuth } from '../auth/AuthContext';
import { isOverdue, sortByPriority } from '../domain/overdue';
import { isOpen, type Incident } from '../domain/types';
import { IncidentCard } from '../components/incident';
import { EmptyState, ErrorState, Spinner } from '../components/ui';
import { hasCapability } from '../domain/permissions';

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

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'red' | 'orange' }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white px-3 py-2.5 dark:border-neutral-700 dark:bg-neutral-900">
      <div
        className={`text-2xl font-bold ${
          value > 0 && tone === 'red'
            ? 'text-red-700 dark:text-red-400'
            : value > 0 && tone === 'orange'
              ? 'text-orange-700 dark:text-orange-400'
              : ''
        }`}
      >
        {value}
      </div>
      <div className="text-xs text-muted">{label}</div>
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
    const partialReadiness = all.filter(
      (i) => i.status === 'closed' && i.followUpRequired && !i.followUpCompletedAt,
    );
    const recentlyClosed = all
      .filter((i) => i.status === 'closed' && !(i.followUpRequired && !i.followUpCompletedAt))
      .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
      .slice(0, 5);
    return { open, overdue, critical, needsAttention, overdueRest, inProgress, waiting, partialReadiness, recentlyClosed };
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
      <p className="mt-1 text-neutral-700 dark:text-neutral-300" data-testid="summary-sentence">
        {summarySentence(derived.open, derived.overdue)}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="תקלות פתוחות" value={derived.open.length} />
        <Stat label="קריטיות / גבוהות" value={derived.critical.length} tone="red" />
        <Stat label="עדכונים באיחור" value={derived.overdue.length} tone="red" />
        <Stat label="כשירות לא מלאה" value={derived.partialReadiness.length} tone="orange" />
      </div>

      {derived.open.length === 0 && derived.partialReadiness.length === 0 && (
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
      <Section title="כשירות לא מלאה" incidents={derived.partialReadiness}>{card}</Section>

      {derived.recentlyClosed.length > 0 && (
        <section className="mt-8">
          <h2 className="group-title mb-2">נסגרו לאחרונה</h2>
          <ul className="flex flex-col gap-1">
            {derived.recentlyClosed.map((i) => (
              <li key={i.id} className="text-sm">
                <Link to={`/incidents/${i.id}`} className="text-brand-700 hover:underline dark:text-brand-400">
                  {i.number}
                </Link>{' '}
                <span className="text-neutral-600 dark:text-neutral-300">
                  {systemName(i.systemId)} — נסגרה
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
