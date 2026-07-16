import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useHandovers, useProfiles } from '../data/hooks';
import { hasCapability } from '../domain/permissions';
import { Badge, EmptyState, ErrorState, Spinner } from '../components/ui';
import { formatDateTime, formatRelative } from '../lib/time';

export default function HandoversPage() {
  const { user } = useAuth();
  const { data: handovers, isLoading, isError, refetch } = useHandovers();
  const { data: profiles } = useProfiles();
  if (!user) return null;

  const name = (id: string) => profiles?.find((p) => p.id === id)?.fullName ?? '—';

  if (isLoading) return <Spinner label="טוען העברות משמרת…" />;
  if (isError) return <ErrorState message="שגיאה בטעינת העברות המשמרת." onRetry={() => refetch()} />;

  const pendingForMe = (handovers ?? []).filter((h) => h.status === 'pending' && h.toUserId === user.id);
  const others = (handovers ?? []).filter((h) => !(h.status === 'pending' && h.toUserId === user.id));

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="page-title">העברת משמרת</h1>
        {hasCapability(user.role, 'create_handover') && (
          <Link
            to="/handovers/new"
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 active:scale-[0.98] dark:bg-brand-500 dark:hover:bg-brand-400"
          >
            יצירת העברת משמרת
          </Link>
        )}
      </div>

      {pendingForMe.length > 0 && (
        <section className="mt-4">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-orange-700 dark:text-orange-400">ממתינות לאישורך</h2>
          <div className="flex flex-col gap-2">
            {pendingForMe.map((h) => (
              <Link
                key={h.id}
                to={`/handovers/${h.id}`}
                className="block rounded-xl border border-orange-300 bg-orange-50 p-3 shadow-soft transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-elevated dark:border-orange-800 dark:bg-orange-950"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-text-primary">מאת {name(h.createdBy)}</span>
                  <Badge color="orange">ממתינה לאישור</Badge>
                </div>
                <p className="mt-1 text-sm text-secondary">
                  {formatRelative(h.createdAt)} · {formatDateTime(h.createdAt)}
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="mt-6">
        <h2 className="group-title mb-2">כל ההעברות</h2>
        {others.length === 0 && pendingForMe.length === 0 ? (
          <EmptyState title="אין עדיין העברות משמרת" />
        ) : (
          <div className="flex flex-col gap-2">
            {others.map((h) => (
              <Link
                key={h.id}
                to={`/handovers/${h.id}`}
                className="surface-interactive block p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-text-primary">{name(h.createdBy)} ← {name(h.toUserId)}</span>
                  <Badge color={h.status === 'accepted' ? 'green' : 'orange'}>
                    {h.status === 'accepted' ? 'אושרה' : 'ממתינה'}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-secondary">
                  {formatDateTime(h.createdAt)}
                  {h.acceptedAt && ` · אושרה ב-${formatDateTime(h.acceptedAt)}`}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
