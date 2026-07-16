import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useHandover, useProfiles, useAppMutation, useCanExport, repo } from '../data/hooks';
import { useAuth, useSession } from '../auth/AuthContext';
import { SeverityBadge, StatusBadge } from '../components/incident';
import { Badge, Button, ErrorState, Field, Spinner, Textarea, useToast } from '../components/ui';
import { formatDateTime } from '../lib/time';
import { buildHandoverPdf, handoverPdfFilename } from '../exports/handoverPdf';
import { downloadPdf } from '../exports/pdf';
import { AppError } from '../data/repository';

export default function HandoverDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const session = useSession();
  const toast = useToast();
  const { data, isLoading, isError, refetch } = useHandover(id);
  const { data: profiles } = useProfiles();
  const { data: canExport } = useCanExport();
  const [addendumText, setAddendumText] = useState('');

  const acceptMutation = useAppMutation((handoverId: string) => repo().acceptHandover(session, handoverId), {
    successText: 'העברת המשמרת אושרה.',
    invalidate: [['handover'], ['handovers'], ['notifications']],
  });
  const addendumMutation = useAppMutation(
    (vars: { handoverId: string; text: string }) => repo().addHandoverAddendum(session, vars.handoverId, vars.text),
    { successText: 'התוספת נשמרה.', invalidate: [['handover']], onSuccess: () => setAddendumText('') },
  );

  if (isLoading) return <Spinner label="טוען העברת משמרת…" />;
  if (isError || !data) return <ErrorState message="שגיאה בטעינת העברת המשמרת." onRetry={() => refetch()} />;
  if (!user) return null;

  const { handover, items, addenda } = data;
  const name = (uid: string) => profiles?.find((p) => p.id === uid)?.fullName ?? '—';
  const canAccept = handover.status === 'pending' && handover.toUserId === user.id;

  const exportPdf = async () => {
    try {
      await repo().recordExport(session, { exportType: 'handover_pdf', filtersDescription: handover.id });
      const pdf = buildHandoverPdf(handover, items, addenda, profiles ?? [], user.fullName);
      downloadPdf(pdf, handoverPdfFilename(handover));
      toast('קובץ ה-PDF הופק בהצלחה.');
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError('NETWORK', 'הפקת ה-PDF נכשלה.');
      toast(err.message, 'error');
    }
  };

  return (
    <div className="mx-auto max-w-2xl pb-12">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="page-title">העברת משמרת</h1>
          <p className="text-neutral-600 dark:text-neutral-300">
            {name(handover.createdBy)} ← {name(handover.toUserId)}
          </p>
        </div>
        <Badge color={handover.status === 'accepted' ? 'green' : 'orange'}>
          {handover.status === 'accepted' ? 'אושרה' : 'ממתינה לאישור'}
        </Badge>
      </div>

      <div className="mt-3 rounded-xl border border-neutral-200 bg-white p-4 text-sm dark:border-neutral-700 dark:bg-neutral-900">
        <p>נוצרה: {formatDateTime(handover.createdAt)}</p>
        {handover.acceptedAt && <p>אושרה: {formatDateTime(handover.acceptedAt)} על ידי {name(handover.acceptedBy ?? '')}</p>}
        {handover.generalNote && <p className="mt-2 whitespace-pre-wrap">{handover.generalNote}</p>}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {canAccept && (
          <Button onClick={() => acceptMutation.mutate(handover.id)} disabled={acceptMutation.isPending}>
            {acceptMutation.isPending ? 'מאשר…' : 'אישור קבלת המשמרת'}
          </Button>
        )}
        {canExport && <Button variant="secondary" onClick={exportPdf}>ייצוא PDF</Button>}
      </div>

      <h2 className="section-title mt-6 mb-2">תקלות שנכללו ({items.length})</h2>
      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <Link
            key={item.id}
            to={`/incidents/${item.incidentId}`}
            className="block rounded-xl border border-neutral-200 bg-white p-3 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-brand-700 dark:text-brand-400">{item.snapshotNumber}</span>
              <span>{item.snapshotSystemName}</span>
              <span className="ms-auto flex gap-1.5">
                <SeverityBadge severity={item.snapshotSeverity} />
                <StatusBadge status={item.snapshotStatus} />
              </span>
            </div>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">גורם מטפל: {item.snapshotOwnerLabel}</p>
            <p className="mt-1 text-sm">פעולה אחרונה: {item.snapshotLastAction || '—'}</p>
            <p className="text-sm">פעולת המשך: {item.snapshotNextSteps || '—'}</p>
            {item.note && <p className="mt-1 text-sm font-medium text-brand-800 dark:text-brand-300">הערת מסירה: {item.note}</p>}
          </Link>
        ))}
      </div>

      {handover.status === 'accepted' && (
        <section className="mt-6">
          <h2 className="section-title mb-2">תוספות</h2>
          {addenda.map((a) => (
            <div key={a.id} className="mb-2 rounded-lg bg-neutral-50 p-3 text-sm dark:bg-neutral-800/60">
              <p className="text-xs text-muted">{name(a.authorId)} · {formatDateTime(a.createdAt)}</p>
              <p className="mt-1 whitespace-pre-wrap">{a.text}</p>
            </div>
          ))}
          <Field label="הוספת תוספת">
            {(a) => <Textarea {...a} value={addendumText} onChange={(e) => setAddendumText(e.target.value)} maxLength={2000} />}
          </Field>
          <div className="mt-2 flex justify-end">
            <Button
              variant="secondary"
              disabled={!addendumText.trim() || addendumMutation.isPending}
              onClick={() => addendumMutation.mutate({ handoverId: handover.id, text: addendumText.trim() })}
            >
              הוספת תוספת
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
