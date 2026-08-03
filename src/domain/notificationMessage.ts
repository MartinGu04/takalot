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

// Appended to the opening/closure messages only -- gives the WhatsApp
// recipient a direct link to the incident's own page. Built from the
// current origin (never a hardcoded domain, so Preview deployments link to
// themselves) and the incident's persisted id (the same identifier the
// /incidents/:id route itself expects, not the displayed human-readable
// number).
function buildIncidentLinkBlock(incidentId: string): string {
  return `\n\nלצפייה בתקלה:\n${window.location.origin}/incidents/${incidentId}`;
}

export function buildIncidentOpenedMessage(
  incident: Pick<Incident, 'id' | 'number' | 'severity'>,
  systemName: string,
  actorName: string,
): string {
  const opening = `${severityEmoji[incident.severity]} נפתחה תקלה ${severityOpeningWording[incident.severity]} ${incident.number} במערכת ${systemName} על ידי ${actorName}`;
  return opening + buildIncidentLinkBlock(incident.id);
}

export function buildIncidentClosedMessage(
  incident: Pick<Incident, 'id' | 'number' | 'discoveredAt' | 'closedAt' | 'createdAt'>,
  systemName: string,
  actorName: string,
): string {
  const duration = formatDuration(incident.discoveredAt, incident.closedAt ?? incident.createdAt);
  const closing = `✅ תקלה ${incident.number} במערכת ${systemName} נסגרה על ידי ${actorName} לאחר ${duration}`;
  return closing + buildIncidentLinkBlock(incident.id);
}
