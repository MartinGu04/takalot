import { useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import {
  useIncident,
  useIncidentEvents,
  useIncidentUpdates,
  useLocations,
  useProfiles,
  useSystems,
  useAppMutation,
  useCanExport,
  repo,
} from '../data/hooks';
import { useAuth, useSession } from '../auth/AuthContext';
import { isOpen } from '../domain/types';
import { hasCapability, canTechnicianUpdate } from '../domain/permissions';
import { SeverityBadge, StatusBadge, ReadinessBadge, ownerDisplay, NextUpdateNote } from '../components/incident';
import { Timeline } from '../components/Timeline';
import { Button, EmptyState, ErrorState, Spinner, useToast } from '../components/ui';
import { formatDateTime, formatDuration } from '../lib/time';
import { reportedToOpsLabels } from '../domain/labels';
import { UpdateDialog } from '../components/dialogs/UpdateDialog';
import { AssignDialog } from '../components/dialogs/AssignDialog';
import { CloseDialog } from '../components/dialogs/CloseDialog';
import { CancelDialog } from '../components/dialogs/CancelDialog';
import { ReopenDialog } from '../components/dialogs/ReopenDialog';
import { CorrectionDialog, FollowUpDialog } from '../components/dialogs/SimpleTextDialogs';
import { buildIncidentPdf, incidentPdfFilename } from '../exports/incidentPdf';
import { downloadPdf } from '../exports/pdf';
import { AppError } from '../data/repository';
import type {
  UpdateIncidentInput,
  TechnicianUpdateInput,
  AssignIncidentInput,
  CloseIncidentInput,
  CancelIncidentInput,
  ReopenIncidentInput,
} from '../domain/schemas';

export default function IncidentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const justCreated = (location.state as { justCreated?: boolean } | null)?.justCreated;
  const { user } = useAuth();
  const session = useSession();
  const toast = useToast();

  const { data: incident, isLoading, isError, refetch } = useIncident(id);
  const { data: events, refetch: refetchEvents } = useIncidentEvents(id);
  const { data: updates, refetch: refetchUpdates } = useIncidentUpdates(id);
  const { data: profiles } = useProfiles();
  const { data: systems } = useSystems();
  const { data: locations } = useLocations();
  const { data: canExport } = useCanExport();

  const [dialog, setDialog] = useState<
    | null
    | 'update'
    | 'assign'
    | 'close'
    | 'cancel'
    | 'reopen'
    | 'followup'
    | { correction: { refId: string; label: string } }
  >(null);

  const now = new Date();

  const refreshAll = () => {
    refetch();
    refetchEvents();
    refetchUpdates();
  };

  function onConflict(error: AppError) {
    if (error.code === 'CONFLICT') {
      toast(error.message, 'error', { label: 'רענון נתונים', onClick: refreshAll });
    } else {
      toast(error.message, 'error');
    }
  }

  const ackMutation = useAppMutation(
    () => repo().acknowledgeIncident(session, id!, incident!.version),
    { successText: 'התקלה סומנה כהתקבלה.', onError: onConflict },
  );
  const updateFullMutation = useAppMutation(
    (input: UpdateIncidentInput) => repo().updateIncident(session, id!, input),
    { successText: 'העדכון נשמר.', onSuccess: () => setDialog(null), onError: onConflict },
  );
  const updateTechMutation = useAppMutation(
    (input: TechnicianUpdateInput) => repo().technicianUpdate(session, id!, input),
    { successText: 'העדכון נשמר.', onSuccess: () => setDialog(null), onError: onConflict },
  );
  const assignMutation = useAppMutation(
    (input: AssignIncidentInput) => repo().assignIncident(session, id!, input),
    { successText: 'גורם מטפל עודכן.', onSuccess: () => setDialog(null), onError: onConflict },
  );
  const closeMutation = useAppMutation(
    (input: CloseIncidentInput) => repo().closeIncident(session, id!, input),
    { successText: 'התקלה נסגרה.', onSuccess: () => setDialog(null), onError: onConflict },
  );
  const cancelMutation = useAppMutation(
    (input: CancelIncidentInput) => repo().cancelIncident(session, id!, input),
    { successText: 'התקלה בוטלה.', onSuccess: () => setDialog(null), onError: onConflict },
  );
  const reopenMutation = useAppMutation(
    (input: ReopenIncidentInput) => repo().reopenIncident(session, id!, input),
    { successText: 'התקלה נפתחה מחדש.', onSuccess: () => setDialog(null), onError: onConflict },
  );
  const correctionMutation = useAppMutation(
    (vars: { refId: string; text: string }) => repo().addCorrection(session, id!, vars),
    { successText: 'התיקון נשמר.', onSuccess: () => setDialog(null) },
  );
  const followUpMutation = useAppMutation(
    (note: string) => repo().completeFollowUp(session, id!, note),
    { successText: 'פעולות ההמשך סומנו כהושלמו.', onSuccess: () => setDialog(null) },
  );

  if (isLoading) return <Spinner label="טוען תקלה…" />;
  if (isError) return <ErrorState message="שגיאה בטעינת התקלה." onRetry={() => refetch()} />;
  if (!incident) return <EmptyState title="התקלה לא נמצאה" subtitle="ייתכן שהקישור שגוי או שאין לך הרשאה לצפות בה." />;
  if (!user) return null;

  const systemName = systems?.find((s) => s.id === incident.systemId)?.name ?? '—';
  const locationName = locations?.find((l) => l.id === incident.locationId)?.name ?? '—';
  const isClosed = incident.status === 'closed';
  // Terminal covers both closed and cancelled: a cancelled incident is not
  // updatable/assignable/closeable either, matching the backend's terminal
  // guards on update_incident/assign_incident/close_incident. Reopening and
  // the closure-summary block below stay literally closed-only -- a
  // cancelled incident is not reopenable (no such backend flow exists) and
  // has no root-cause/resolution/readiness data to show.
  const isTerminal = !isOpen(incident.status);
  const canFullUpdate = hasCapability(user.role, 'full_update') && !isTerminal;
  const canTechUpdate = canTechnicianUpdate(user.id, incident);
  const canAssign = hasCapability(user.role, 'assign_incident') && !isTerminal;
  const canClose = hasCapability(user.role, 'close_incident') && !isTerminal;
  const canCancel = hasCapability(user.role, 'cancel_incident') && !isTerminal;
  const canReopen = hasCapability(user.role, 'reopen_incident') && isClosed;
  const canAck = hasCapability(user.role, 'acknowledge_incident') && incident.status === 'new';
  const canCompleteFollowUp =
    hasCapability(user.role, 'complete_follow_up') &&
    incident.followUpRequired &&
    !incident.followUpCompletedAt &&
    !isTerminal;

  const exportPdf = async () => {
    try {
      await repo().recordExport(session, { exportType: 'incident_pdf', filtersDescription: incident.number });
      const pdf = buildIncidentPdf(
        incident,
        events ?? [],
        updates ?? [],
        profiles ?? [],
        systems ?? [],
        locations ?? [],
        user.fullName,
      );
      downloadPdf(pdf, incidentPdfFilename(incident.number));
      toast('קובץ ה-PDF הופק בהצלחה.');
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError('NETWORK', 'הפקת ה-PDF נכשלה. ניתן לנסות שוב.');
      toast(err.message, 'error');
    }
  };

  return (
    <div className="mx-auto max-w-3xl pb-16">
      {justCreated && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
        >
          התקלה {incident.number} נפתחה בהצלחה.
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="page-title">
            {incident.number} · {systemName}
          </h1>
          <p className="text-muted">{locationName}</p>
        </div>
        <div className="flex gap-1.5">
          <SeverityBadge severity={incident.severity} />
          <StatusBadge status={incident.status} />
        </div>
      </div>

      <NextUpdateNote incident={incident} now={now} />

      {incident.followUpRequired && !incident.followUpCompletedAt && (
        <div className="mt-3 rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm text-orange-900 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200">
          כשירות לא מלאה — נדרשות פעולות המשך: {incident.followUpNotes}
        </div>
      )}

      <div className="surface mt-4 p-4 [&_dd]:font-medium [&_dd]:text-text-primary">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">גורם מטפל נוכחי</dt>
            <dd className="font-medium">{ownerDisplay(incident, profiles)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">השפעה מבצעית</dt>
            <dd>{incident.operationalImpact}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">שעת גילוי</dt>
            <dd>{formatDateTime(incident.discoveredAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">עדכון אחרון</dt>
            <dd>{formatDateTime(incident.lastUpdateAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">דווח למבצעים</dt>
            <dd>
              {reportedToOpsLabels[incident.reportedToOps]}
              {incident.reportedToOps === 'yes' && incident.reportedToOpsRecipient && (
                <span className="font-normal text-secondary"> — {incident.reportedToOpsRecipient}</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">תקשוב למבצעים</dt>
            <dd>
              {incident.reportedToComms ? 'כן' : 'לא'}
              {incident.reportedToComms && incident.reportedToCommsRecipient && (
                <span className="font-normal text-secondary"> — {incident.reportedToCommsRecipient}</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">WISDOM</dt>
            <dd>
              {incident.wisdomReported ? 'כן' : 'לא'}
              {incident.wisdomReported && incident.wisdomIncidentNumber && (
                <span className="font-normal text-secondary"> — מספר תקלה: {incident.wisdomIncidentNumber}</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">תיאור</dt>
            <dd className="whitespace-pre-wrap break-words">{incident.description}</dd>
          </div>
        </dl>
      </div>

      {isClosed && (
        <div className="surface mt-4 p-4 [&_dd]:font-medium [&_dd]:text-text-primary">
          <h2 className="section-title">סיכום סגירה</h2>
          <dl className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div><dt className="text-xs text-muted">שעת סגירה</dt><dd>{formatDateTime(incident.closedAt)}</dd></div>
            <div>
              <dt className="text-xs text-muted">משך התקלה</dt>
              <dd>{formatDuration(incident.discoveredAt, incident.closedAt ?? incident.createdAt)}</dd>
            </div>
            <div><dt className="text-xs text-muted">סיבת התקלה</dt><dd>{incident.rootCause}</dd></div>
            <div><dt className="text-xs text-muted">הפתרון שבוצע</dt><dd>{incident.resolution}</dd></div>
            <div>
              <dt className="text-xs text-muted">כשירות</dt>
              <dd>{incident.readinessAtClose && <ReadinessBadge readiness={incident.readinessAtClose} />}</dd>
            </div>
            {incident.followUpCompletedAt && (
              <div><dt className="text-xs text-muted">פעולות המשך</dt><dd>הושלמו ב-{formatDateTime(incident.followUpCompletedAt)}</dd></div>
            )}
          </dl>
        </div>
      )}

      <div className="surface sticky bottom-16 z-10 mt-4 flex flex-wrap gap-2 bg-surface/95 p-3 backdrop-blur md:static md:bottom-auto">
        {canAck && <Button onClick={() => ackMutation.mutate(undefined)} disabled={ackMutation.isPending}>אישור קבלה</Button>}
        {(canFullUpdate || canTechUpdate) && <Button onClick={() => setDialog('update')}>עדכון תקלה</Button>}
        {canAssign && <Button variant="secondary" onClick={() => setDialog('assign')}>שינוי גורם מטפל</Button>}
        {canClose && <Button variant="danger" onClick={() => setDialog('close')}>סגירת תקלה</Button>}
        {canCancel && (
          <Button
            variant="secondary"
            className="text-red-700 hover:text-red-800 dark:text-red-400"
            onClick={() => setDialog('cancel')}
          >
            ביטול תקלה
          </Button>
        )}
        {canReopen && <Button variant="secondary" onClick={() => setDialog('reopen')}>פתיחה מחדש</Button>}
        {canCompleteFollowUp && <Button variant="secondary" onClick={() => setDialog('followup')}>השלמת פעולות המשך</Button>}
        {canExport && <Button variant="secondary" onClick={exportPdf}>ייצוא PDF</Button>}
      </div>

      <section className="mt-6">
        <h2 className="section-title mb-2">ציר זמן</h2>
        <Timeline
          events={events ?? []}
          updates={updates ?? []}
          profiles={profiles}
          currentUserId={user.id}
          canCorrectAny={hasCapability(user.role, 'full_update')}
          onCorrect={(refId, label) => setDialog({ correction: { refId, label } })}
        />
      </section>

      <UpdateDialog
        open={dialog === 'update'}
        onClose={() => setDialog(null)}
        incident={incident}
        submitting={updateFullMutation.isPending || updateTechMutation.isPending}
        onSubmitFull={(input) => updateFullMutation.mutate(input)}
        onSubmitTechnician={(input) => updateTechMutation.mutate(input)}
      />
      <AssignDialog
        open={dialog === 'assign'}
        onClose={() => setDialog(null)}
        incident={incident}
        submitting={assignMutation.isPending}
        onSubmit={(input) => assignMutation.mutate(input)}
      />
      <CloseDialog
        open={dialog === 'close'}
        onClose={() => setDialog(null)}
        incident={incident}
        submitting={closeMutation.isPending}
        onSubmit={(input) => closeMutation.mutate(input)}
      />
      <CancelDialog
        open={dialog === 'cancel'}
        onClose={() => setDialog(null)}
        incident={incident}
        submitting={cancelMutation.isPending}
        onSubmit={(input) => cancelMutation.mutate(input)}
      />
      <ReopenDialog
        open={dialog === 'reopen'}
        onClose={() => setDialog(null)}
        incident={incident}
        submitting={reopenMutation.isPending}
        onSubmit={(input) => reopenMutation.mutate(input)}
      />
      <FollowUpDialog
        open={dialog === 'followup'}
        onClose={() => setDialog(null)}
        submitting={followUpMutation.isPending}
        onSubmit={(note) => followUpMutation.mutate(note)}
      />
      {typeof dialog === 'object' && dialog?.correction && (
        <CorrectionDialog
          open
          onClose={() => setDialog(null)}
          refLabel={dialog.correction.label}
          submitting={correctionMutation.isPending}
          onSubmit={(text) => correctionMutation.mutate({ refId: dialog.correction.refId, text })}
        />
      )}
    </div>
  );
}
