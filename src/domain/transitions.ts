// Fixed status transition rules, validated by the backend layer.
import type { IncidentStatus } from './types';
import { statusLabels } from './labels';

const ACTIVE_TARGETS: IncidentStatus[] = [
  'in_progress',
  'waiting_external',
  'waiting_test',
  'monitoring',
  'partial_readiness',
  'resolved_pending_close',
];

export const allowedTransitions: Record<IncidentStatus, IncidentStatus[]> = {
  new: ['acknowledged', 'in_progress'],
  acknowledged: ACTIVE_TARGETS,
  in_progress: ACTIVE_TARGETS.filter((s) => s !== 'in_progress'),
  waiting_external: ACTIVE_TARGETS.filter((s) => s !== 'waiting_external'),
  waiting_test: ACTIVE_TARGETS.filter((s) => s !== 'waiting_test'),
  monitoring: ACTIVE_TARGETS.filter((s) => s !== 'monitoring'),
  partial_readiness: ACTIVE_TARGETS.filter((s) => s !== 'partial_readiness'),
  resolved_pending_close: ['in_progress', 'monitoring', 'waiting_test'],
  // 'closed' is reachable only through the dedicated closure flow,
  // and 'reopened' only through the dedicated reopen flow.
  closed: [],
  reopened: ['acknowledged', ...ACTIVE_TARGETS],
};

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  if (from === to) return true; // keeping the same status in an update is always valid
  return allowedTransitions[from].includes(to);
}

export function transitionError(from: IncidentStatus, to: IncidentStatus): string {
  if (to === 'closed') {
    return 'סגירת תקלה מתבצעת רק דרך טופס הסגירה הייעודי.';
  }
  if (from === 'closed') {
    return 'תקלה סגורה ניתן לפתוח מחדש רק דרך פעולת "פתיחה מחדש".';
  }
  return `לא ניתן לעבור מסטטוס "${statusLabels[from]}" לסטטוס "${statusLabels[to]}".`;
}
