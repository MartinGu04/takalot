// Fixed status transition rules, validated by the backend layer.
import type { IncidentStatus } from './types';
import { isOpen } from './types';
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
  // 'cancelled' is terminal and reachable only through its own dedicated
  // flow (not yet exposed in any UI) -- no outgoing transitions.
  cancelled: [],
  // waiting_equipment/waiting_information/waiting_validation are NOT added
  // to ACTIVE_TARGETS: the backend's is_valid_transition (migration 0017)
  // was never updated to allow transitioning INTO any of these three as a
  // target from any status, so offering them here would let the UI present
  // an option the backend always rejects. Outgoing transitions FROM one of
  // these statuses (should one ever exist in historical or externally
  // inserted data) already work correctly via the backend's unchanged
  // fallback branch, so they get the same target list as any other
  // non-terminal status.
  waiting_equipment: ACTIVE_TARGETS,
  waiting_information: ACTIVE_TARGETS,
  waiting_validation: ACTIVE_TARGETS,
};

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  // A terminal status can never "transition" to itself either -- matches
  // the backend's is_valid_transition, which rejects a same-status update
  // once the source is closed/cancelled.
  if (from === to) return isOpen(from);
  return allowedTransitions[from].includes(to);
}

export function transitionError(from: IncidentStatus, to: IncidentStatus): string {
  if (to === 'closed') {
    return 'סגירת תקלה מתבצעת רק דרך טופס הסגירה הייעודי.';
  }
  if (from === 'closed') {
    return 'תקלה סגורה ניתן לפתוח מחדש רק דרך פעולת "פתיחה מחדש".';
  }
  if (to === 'cancelled' || from === 'cancelled') {
    return 'תקלה מבוטלת אינה ניתנת לעדכון.';
  }
  return `לא ניתן לעבור מסטטוס "${statusLabels[from]}" לסטטוס "${statusLabels[to]}".`;
}
