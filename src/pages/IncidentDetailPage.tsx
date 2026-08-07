import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import {
  useIncident,
  useIncidentEvents,
  useIncidentUpdates,
  useIncidentCauseAssessments,
  useIncidentTreatmentActions,
  useIncidentClosures,
  useIncidentRelations,
  useLocations,
  useProfiles,
  useSystems,
  useAppMutation,
  useCanExport,
  repo,
} from '../data/hooks';
import { useAuth, useSession } from '../auth/AuthContext';
import { isOpen, type Incident } from '../domain/types';
import { hasCapability, canTechnicianUpdate } from '../domain/permissions';
import { SeverityBadge, StatusBadge, ReadinessBadge, ownerDisplay, externalHandlerDisplay } from '../components/incident';
import { Timeline } from '../components/Timeline';
import { CurrentStateSummary } from '../components/CurrentStateSummary';
import { RelatedIncidentsSection } from '../components/RelatedIncidentsSection';
import { Button, EmptyState, ErrorState, Spinner, useToast } from '../components/ui';
import { formatDateTime, formatDuration } from '../lib/time';
import {
  reportedToOpsLabels,
  incidentDomainLabels,
  UNCLASSIFIED_DOMAIN_LABEL,
  suspectedCauseLabels,
  UNASSESSED_CAUSE_LABEL,
  confirmedCauseLabels,
  treatmentOutcomeLabels,
} from '../domain/labels';
import { UpdateDialog } from '../components/dialogs/UpdateDialog';
import { AssignDialog } from '../components/dialogs/AssignDialog';
import { CloseDialog } from '../components/dialogs/CloseDialog';
import { CancelDialog } from '../components/dialogs/CancelDialog';
import { ReopenDialog } from '../components/dialogs/ReopenDialog';
import { CorrectionDialog, FollowUpDialog } from '../components/dialogs/SimpleTextDialogs';
import { NotificationCopyDialog } from '../components/dialogs/NotificationCopyDialog';
import { buildIncidentPdf, incidentPdfFilename } from '../exports/incidentPdf';
import { downloadPdf } from '../exports/pdf';
import { AppError } from '../data/repository';
import { IconChevronDown } from '../components/icons';
import { buildIncidentClosedMessage } from '../domain/notificationMessage';
import type {
  UpdateIncidentInput,
  TechnicianUpdateInput,
  AssignIncidentInput,
  CloseIncidentInput,
  CancelIncidentInput,
  ReopenIncidentInput,
} from '../domain/schemas';

function IncidentMoreActions({
  canExport,
  canCancel,
  onExport,
  onCancel,
}: {
  canExport: boolean;
  canCancel: boolean;
  onExport: () => void;
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<'first' | 'last'>('first');

  const menuItems = () =>
    Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);

  const closeAndFocusTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const openMenu = (focus: 'first' | 'last') => {
    focusOnOpen.current = focus;
    setOpen(true);
  };

  const selectAction = (action: () => void) => {
    setOpen(false);
    triggerRef.current?.focus();
    action();
  };

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const items = menuItems();
      (focusOnOpen.current === 'last' ? items.at(-1) : items[0])?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAndFocusTrigger();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  const focusAdjacentPageControl = (backwards: boolean) => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !panelRef.current?.contains(element));
    const currentIndex = controls.indexOf(trigger);
    controls[currentIndex + (backwards ? -1 : 1)]?.focus();
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      setOpen(false);
      focusAdjacentPageControl(event.shiftKey);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = menuItems();
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Home') {
      items[0].focus();
    } else if (event.key === 'End') {
      items.at(-1)?.focus();
    } else {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + step + items.length) % items.length;
      items[nextIndex].focus();
    }
  };

  if (!canExport && !canCancel) return null;

  return (
    <div className="relative w-full sm:ms-auto sm:w-auto">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => (open ? setOpen(false) : openMenu('first'))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu(event.key === 'ArrowUp' ? 'last' : 'first');
          }
        }}
        className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-hairline-strong bg-surface px-4 py-2 text-sm font-medium text-text-primary shadow-soft hover:bg-surface-hover active:scale-[0.98] sm:w-auto"
      >
        פעולות נוספות
        <IconChevronDown className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          ref={panelRef}
          className="popover-panel absolute bottom-full end-0 z-50 mb-2 w-full min-w-52 animate-scale-in p-1.5 sm:w-56"
        >
          <div id={menuId} role="menu" aria-label="פעולות נוספות לתקלה" onKeyDown={handleMenuKeyDown}>
            {canExport && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => selectAction(onExport)}
                className="flex min-h-10 w-full items-center rounded-lg px-3 py-2 text-right text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary"
              >
                ייצוא PDF
              </button>
            )}
            {canCancel && (
              <div className={canExport ? 'mt-1 border-t border-hairline pt-1' : undefined}>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => selectAction(onCancel)}
                  className="flex min-h-10 w-full items-center rounded-lg px-3 py-2 text-right text-sm font-medium text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/50"
                >
                  ביטול תקלה
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

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
  const { data: causeAssessments } = useIncidentCauseAssessments(id);
  const { data: treatmentActions } = useIncidentTreatmentActions(id);
  const { data: closures } = useIncidentClosures(id);
  const { data: relations } = useIncidentRelations(id);
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
  const [closedNotification, setClosedNotification] = useState<Incident | null>(null);

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
    {
      successText: 'התקלה נסגרה.',
      onSuccess: (result) => {
        setDialog(null);
        // A submission with partial readiness keeps the incident open (see
        // closeIncident/close_incident) -- only a genuine close (closedAt
        // set) should prompt the WhatsApp notification-copy modal.
        if (result.status === 'closed' && result.closedAt) setClosedNotification(result);
      },
      onError: onConflict,
    },
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
  const currentClosure = closures?.find((c) => c.cycleNumber === incident.reopenCount);
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
  const canUpdate = canFullUpdate || canTechUpdate;
  const hasActions =
    canAck ||
    canUpdate ||
    canAssign ||
    canClose ||
    canCancel ||
    canReopen ||
    canCompleteFollowUp ||
    Boolean(canExport);

  const exportPdf = async () => {
    try {
      await repo().recordExport(session, { exportType: 'incident_pdf', filtersDescription: incident.number });
      // Fetched directly here, NOT read from this page's own
      // useIncidentCauseAssessments/useIncidentTreatmentActions/
      // useIncidentClosures background queries: unlike events/updates
      // (which gate the visible Timeline section, so they're always
      // resolved by the time a user could plausibly click "ייצוא PDF"),
      // nothing currently on screen depends on these three resolving --
      // "תחום התקלה"/"חשד נוכחי" come straight off the `incident` row, and
      // Timeline renders fine with them still undefined. A user can reach
      // and click the export action before their first fetch completes;
      // reading `causeAssessments ?? []` etc. at that moment would
      // silently bake a permanently incomplete PDF (unlike the on-screen
      // Timeline, which self-heals on the next re-render once the query
      // resolves -- a downloaded file gets no such second chance). Fetching
      // fresh here removes the race entirely.
      const [freshCauseAssessments, freshTreatmentActions, freshClosures] = await Promise.all([
        repo().getIncidentCauseAssessments(session, incident.id),
        repo().getIncidentTreatmentActions(session, incident.id),
        repo().getIncidentClosures(session, incident.id),
      ]);
      const pdf = await buildIncidentPdf(
        incident,
        events ?? [],
        updates ?? [],
        profiles ?? [],
        systems ?? [],
        locations ?? [],
        user.fullName,
        undefined,
        freshCauseAssessments,
        freshTreatmentActions,
        freshClosures,
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

      {incident.followUpRequired && !incident.followUpCompletedAt && (
        <div className="mt-3 rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm text-orange-900 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200">
          כשירות לא מלאה — נדרשות פעולות המשך: {incident.followUpNotes}
        </div>
      )}

      <CurrentStateSummary
        incident={incident}
        updates={updates ?? []}
        events={events ?? []}
        closures={closures}
        profiles={profiles}
      />

      <div className="surface mt-4 p-4 [&_dd]:font-medium [&_dd]:text-text-primary">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">בעל אחריות פנימי</dt>
            <dd className="font-medium">{ownerDisplay(incident, profiles)}</dd>
          </div>
          {externalHandlerDisplay(incident) && (
            <div>
              <dt className="text-xs text-muted">גורם מטפל חיצוני</dt>
              <dd dir="auto" className="font-medium">{externalHandlerDisplay(incident)}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-muted">השפעה מבצעית</dt>
            <dd>{incident.operationalImpact}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">תחום התקלה</dt>
            <dd>{incident.reportedDomain ? incidentDomainLabels[incident.reportedDomain] : UNCLASSIFIED_DOMAIN_LABEL}</dd>
          </div>
          {isOpen(incident.status) && (
            <div>
              <dt className="text-xs text-muted">חשד נוכחי</dt>
              <dd>{incident.currentSuspectedCause ? suspectedCauseLabels[incident.currentSuspectedCause] : UNASSESSED_CAUSE_LABEL}</dd>
            </div>
          )}
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
            {/* The closure that produced the CURRENT closed state -- the row
                whose cycleNumber matches the incident's own reopenCount.
                Absent for a legacy incident, or one closed through the
                still-permissive legacy close_incident RPC without
                classification -- rendered identically either way (simply
                omitted), never a fabricated "unclassified" value. */}
            {currentClosure && (
              <>
                <div>
                  <dt className="text-xs text-muted">הגורם שאומת</dt>
                  <dd>
                    {confirmedCauseLabels[currentClosure.confirmedCause]}
                    {currentClosure.confirmedCause === 'other' && currentClosure.confirmedCauseOtherDetail
                      ? ` — ${currentClosure.confirmedCauseOtherDetail}`
                      : ''}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">תוצאת הטיפול</dt>
                  <dd className="flex items-center gap-1.5">
                    <span>
                      {treatmentOutcomeLabels[currentClosure.treatmentOutcome]}
                      {currentClosure.treatmentOutcome === 'other' && currentClosure.treatmentOutcomeOtherDetail
                        ? ` — ${currentClosure.treatmentOutcomeOtherDetail}`
                        : ''}
                    </span>
                    {currentClosure.treatmentOutcome === 'temporary_workaround' && (
                      <span className="inline-flex items-center rounded-md border border-orange-300 bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-900 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200">
                        פתרון זמני
                      </span>
                    )}
                  </dd>
                </div>
              </>
            )}
          </dl>
        </div>
      )}

      {hasActions && (
        <section
          aria-label="פעולות תקלה"
          className="surface sticky bottom-16 z-10 mt-4 grid grid-cols-1 gap-2 bg-surface/95 p-3 backdrop-blur md:static md:bottom-auto sm:flex sm:flex-wrap sm:items-center"
        >
          {canUpdate && (
            <Button className="w-full sm:w-auto" onClick={() => setDialog('update')}>
              עדכון תקלה
            </Button>
          )}
          {/* Closure and reassignment stay SECONDARY to עדכון תקלה -- neither
              is filled, and neither competes with the single primary action.
              They only gain their own restrained tint so the two most common
              follow-up actions stop reading as one undifferentiated pair:
              muted green for reaching a completed state, muted indigo for
              handing the incident to someone else. */}
          {canClose && (
            <Button className="w-full sm:w-auto" variant="success" onClick={() => setDialog('close')}>
              סגירת תקלה
            </Button>
          )}
          {canAssign && (
            <Button className="w-full sm:w-auto" variant="info" onClick={() => setDialog('assign')}>
              שינוי גורם מטפל
            </Button>
          )}
          {canAck && (
            <Button
              className="w-full sm:w-auto"
              variant="secondary"
              onClick={() => ackMutation.mutate(undefined)}
              disabled={ackMutation.isPending}
            >
              אישור קבלה
            </Button>
          )}
          {canReopen && (
            <Button className="w-full sm:w-auto" variant="secondary" onClick={() => setDialog('reopen')}>
              פתיחה מחדש
            </Button>
          )}
          {canCompleteFollowUp && (
            <Button className="w-full sm:w-auto" variant="secondary" onClick={() => setDialog('followup')}>
              השלמת פעולות המשך
            </Button>
          )}
          <IncidentMoreActions
            canExport={Boolean(canExport)}
            canCancel={canCancel}
            onExport={() => void exportPdf()}
            onCancel={() => setDialog('cancel')}
          />
        </section>
      )}

      <RelatedIncidentsSection
        incidentId={incident.id}
        relations={relations}
        canManage={hasCapability(user.role, 'manage_incident_relations')}
      />

      <section className="mt-6">
        <h2 className="section-title mb-2">ציר זמן</h2>
        <Timeline
          events={events ?? []}
          updates={updates ?? []}
          profiles={profiles}
          currentUserId={user.id}
          canCorrectAny={hasCapability(user.role, 'full_update')}
          onCorrect={(refId, label) => setDialog({ correction: { refId, label } })}
          discoveredAt={incident.discoveredAt}
          closedAt={incident.closedAt}
          causeAssessments={causeAssessments}
          treatmentActions={treatmentActions}
          closures={closures}
        />
      </section>

      {/* Mounted only while open. The dialog seeds its structured fields
          (status/severity/impact/owner/deadline/reporting) from `incident` in
          its useState initializers, which run once per mount -- so mounting
          per opening is what makes every fresh opening show the incident's
          CURRENT values rather than whatever they were when this page first
          rendered, and makes a confirmed successful submission (the only
          thing that clears `dialog`) start the next update clean.
          A failed submission or a version conflict leaves `dialog` set, so
          the dialog stays mounted with every entered value intact. */}
      {dialog === 'update' && (
        <UpdateDialog
          open
          onClose={() => setDialog(null)}
          incident={incident}
          submitting={updateFullMutation.isPending || updateTechMutation.isPending}
          onSubmitFull={(input) => updateFullMutation.mutate(input)}
          onSubmitTechnician={(input) => updateTechMutation.mutate(input)}
        />
      )}
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
      {closedNotification && (
        <NotificationCopyDialog
          open
          title="התקלה נסגרה בהצלחה"
          message={buildIncidentClosedMessage(closedNotification, systemName, user.fullName)}
          onDismiss={() => setClosedNotification(null)}
        />
      )}
    </div>
  );
}
