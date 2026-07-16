// Unified chronological incident timeline. Readable on mobile; does not rely on color alone.
import type { IncidentEvent, IncidentUpdate, Profile } from '../domain/types';
import {
  eventTypeLabels,
  fieldLabels,
  severityLabels,
  statusLabels,
  readinessLabels,
} from '../domain/labels';
import { formatDateTime } from '../lib/time';

function valueLabel(field: string | null, value: string | null): string {
  if (value == null) return '—';
  if (field === 'status' && value in statusLabels) {
    return statusLabels[value as keyof typeof statusLabels];
  }
  if (field === 'severity' && value in severityLabels) {
    return severityLabels[value as keyof typeof severityLabels];
  }
  if (field === 'next_update_due') return value === 'null' || !value ? 'ללא צפי' : formatDateTime(value);
  return value;
}

const typeIcon: Record<string, string> = {
  created: '●',
  acknowledged: '✓',
  update: '✎',
  status_change: '⇄',
  severity_change: '!',
  impact_change: '!',
  assignment_change: '→',
  deadline_change: '⏱',
  correction: '±',
  handover_included: '⇉',
  handover_accepted: '⇉',
  closed: '■',
  follow_up_completed: '✓',
  reopened: '↺',
};

const CORRECTABLE_TYPES = new Set(['update', 'status_change', 'severity_change', 'impact_change', 'assignment_change']);

export function Timeline({
  events,
  updates,
  profiles,
  currentUserId,
  canCorrectAny,
  onCorrect,
}: {
  events: IncidentEvent[];
  updates: IncidentUpdate[];
  profiles: Profile[] | undefined;
  currentUserId?: string;
  canCorrectAny?: boolean;
  onCorrect?: (refId: string, label: string) => void;
}) {
  const updatesById = new Map(updates.map((u) => [u.id, u]));
  const actorName = (id: string | null, label: string | null) =>
    label ?? (id ? (profiles?.find((p) => p.id === id)?.fullName ?? 'משתמש') : 'המערכת');

  if (events.length === 0) {
    return <p className="py-4 text-sm text-muted">אין אירועים בציר הזמן.</p>;
  }

  return (
    <ol className="relative flex flex-col gap-0">
      {events.map((event, idx) => {
        const update = event.refId ? updatesById.get(event.refId) : undefined;
        const timesDiffer =
          Math.abs(new Date(event.eventTime).getTime() - new Date(event.serverTime).getTime()) > 60_000;
        const emphasized = ['closed', 'reopened', 'created'].includes(event.type);
        return (
          <li key={event.id} className="relative flex gap-3 pb-4">
            {idx < events.length - 1 && (
              <span
                aria-hidden
                className="absolute top-7 right-[11px] bottom-0 w-px bg-hairline"
              />
            )}
            <span
              aria-hidden
              className={`relative z-10 mt-1 flex size-6 shrink-0 items-center justify-center rounded-full text-xs ${
                emphasized
                  ? 'bg-brand-600 text-white dark:bg-brand-500'
                  : 'bg-surface-active text-text-secondary'
              }`}
            >
              {typeIcon[event.type] ?? '•'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-semibold text-text-primary">{eventTypeLabels[event.type]}</span>
                <span className="text-sm text-secondary">
                  {actorName(event.actorId, event.actorLabel)}
                </span>
                <span className="text-xs text-muted">{formatDateTime(event.eventTime)}</span>
                {timesDiffer && (
                  <span className="text-xs text-muted">
                    (נרשם בשרת: {formatDateTime(event.serverTime)})
                  </span>
                )}
              </div>
              {event.field && (
                <p className="mt-0.5 text-sm text-secondary">
                  {fieldLabels[event.field] ?? event.field}:{' '}
                  <span className="line-through opacity-60">{valueLabel(event.field, event.oldValue)}</span>
                  {' ← '}
                  <strong>{valueLabel(event.field, event.newValue)}</strong>
                </p>
              )}
              {event.type === 'closed' && event.newValue && (
                <p className="mt-0.5 text-sm">
                  כשירות בסגירה:{' '}
                  <strong>{readinessLabels[event.newValue as keyof typeof readinessLabels]}</strong>
                </p>
              )}
              {update && (
                <div className="mt-1.5 rounded-lg bg-surface-active p-2.5 text-sm">
                  <p>
                    <span className="font-medium">פעולות שבוצעו: </span>
                    <span className="whitespace-pre-wrap break-words">{update.actionsTaken}</span>
                  </p>
                  {update.findings && (
                    <p className="mt-1">
                      <span className="font-medium">ממצאים: </span>
                      <span className="whitespace-pre-wrap break-words">{update.findings}</span>
                    </p>
                  )}
                  {update.nextSteps && (
                    <p className="mt-1">
                      <span className="font-medium">פעולות המשך: </span>
                      <span className="whitespace-pre-wrap break-words">{update.nextSteps}</span>
                    </p>
                  )}
                </div>
              )}
              {event.note && !update && (
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-secondary">
                  {event.note}
                </p>
              )}
              {event.type === 'correction' && event.refId && (
                <p className="mt-0.5 text-xs text-muted">מתייחס לרישום קודם (הרישום המקורי נשמר)</p>
              )}
              {onCorrect && CORRECTABLE_TYPES.has(event.type) && (event.actorId === currentUserId || canCorrectAny) && (
                <button
                  type="button"
                  className="mt-1 text-xs text-brand-700 hover:underline dark:text-brand-400"
                  onClick={() =>
                    onCorrect(
                      event.type === 'update' && event.refId ? event.refId : event.id,
                      `${eventTypeLabels[event.type]} · ${formatDateTime(event.eventTime)}`,
                    )
                  }
                >
                  תיקון רישום זה
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
