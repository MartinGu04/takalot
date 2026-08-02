// Temporary operational workaround (no real WhatsApp integration yet): builds
// the exact Hebrew message a user copies into the incidents WhatsApp group
// after successfully opening or closing an incident. See
// NotificationCopyDialog for the modal that displays this text.
import type { Incident, Severity } from './types';
import { formatDuration } from '../lib/time';

const severityEmoji: Record<Severity, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
};

// Deliberately not a uniform "בחומרה X" template for every severity: קריטית
// reads naturally as a direct adjective ("תקלה קריטית"), while the other
// levels read more naturally described via "בחומרה" ("תקלה בחומרה גבוהה").
const severityOpeningWording: Record<Severity, string> = {
  critical: 'קריטית',
  high: 'בחומרה גבוהה',
  medium: 'בחומרה בינונית',
  low: 'בחומרה נמוכה',
};

export function buildIncidentOpenedMessage(
  incident: Pick<Incident, 'number' | 'severity'>,
  systemName: string,
  actorName: string,
): string {
  return `${severityEmoji[incident.severity]} נפתחה תקלה ${severityOpeningWording[incident.severity]} ${incident.number} במערכת ${systemName} על ידי ${actorName}`;
}

export function buildIncidentClosedMessage(
  incident: Pick<Incident, 'number' | 'discoveredAt' | 'closedAt' | 'createdAt'>,
  systemName: string,
  actorName: string,
): string {
  const duration = formatDuration(incident.discoveredAt, incident.closedAt ?? incident.createdAt);
  return `✅ תקלה ${incident.number} במערכת ${systemName} נסגרה על ידי ${actorName} לאחר ${duration}`;
}
