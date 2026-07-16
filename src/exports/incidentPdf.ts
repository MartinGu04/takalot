import type { Incident, IncidentEvent, IncidentUpdate, Profile, SystemRecord, LocationRecord } from '../domain/types';
import {
  eventTypeLabels,
  readinessLabels,
  reportedToOpsLabels,
  severityLabels,
  statusLabels,
} from '../domain/labels';
import { formatDateTime, formatDuration } from '../lib/time';
import { HebrewPdf } from './pdf';

export function buildIncidentPdf(
  incident: Incident,
  events: IncidentEvent[],
  updates: IncidentUpdate[],
  profiles: Profile[],
  systems: SystemRecord[],
  locations: LocationRecord[],
  exportedByName: string,
): HebrewPdf {
  const pdf = new HebrewPdf();
  const name = (id: string | null) => (id ? (profiles.find((p) => p.id === id)?.fullName ?? 'לא ידוע') : '');
  const owner = incident.ownerUserId
    ? name(incident.ownerUserId)
    : incident.ownerExternalName
      ? `${incident.ownerExternalName} (גורם חיצוני)`
      : 'ללא';

  pdf.header(`תקלה ${incident.number}`, exportedByName);

  pdf.sectionTitle('פרטי פתיחה');
  pdf.field('מספר תקלה', incident.number);
  pdf.field('מערכת / עמדה', systems.find((s) => s.id === incident.systemId)?.name ?? '');
  pdf.field('מיקום', locations.find((l) => l.id === incident.locationId)?.name ?? '');
  pdf.field('שעת גילוי', formatDateTime(incident.discoveredAt));
  pdf.field('נפתח על ידי', name(incident.createdBy));
  pdf.field('שעת פתיחה', formatDateTime(incident.createdAt));
  pdf.spacer();

  pdf.sectionTitle('מצב נוכחי');
  pdf.field('חומרה', severityLabels[incident.severity]);
  pdf.field('סטטוס', statusLabels[incident.status]);
  pdf.field('השפעה מבצעית', incident.operationalImpact);
  pdf.field('גורם מטפל נוכחי', owner);
  pdf.field('דווח למבצעים', reportedToOpsLabels[incident.reportedToOps]);
  pdf.spacer();

  if (incident.status === 'closed') {
    pdf.sectionTitle('פרטי סגירה');
    pdf.field('שעת סגירה', formatDateTime(incident.closedAt));
    pdf.field('נסגר על ידי', name(incident.closedBy));
    pdf.field('סיבת התקלה', incident.rootCause ?? '');
    pdf.field('הפתרון שבוצע', incident.resolution ?? '');
    pdf.field('כשירות בסגירה', incident.readinessAtClose ? readinessLabels[incident.readinessAtClose] : '');
    pdf.field('משך התקלה', formatDuration(incident.discoveredAt, incident.closedAt ?? incident.createdAt));
    if (incident.followUpRequired) {
      pdf.field('פעולות המשך', incident.followUpNotes ?? '');
      pdf.field(
        'השלמת פעולות המשך',
        incident.followUpCompletedAt ? `הושלם ב-${formatDateTime(incident.followUpCompletedAt)}` : 'טרם הושלם',
      );
    }
    pdf.spacer();
  }

  pdf.sectionTitle('ציר זמן מלא');
  const updatesById = new Map(updates.map((u) => [u.id, u]));
  for (const event of events) {
    pdf.field(
      `${eventTypeLabels[event.type]}`,
      `${formatDateTime(event.eventTime)} — ${event.actorLabel ?? name(event.actorId) ?? 'המערכת'}`,
    );
    if (event.field) {
      pdf.paragraph(`${event.field}: ${event.oldValue ?? '—'} ← ${event.newValue ?? '—'}`);
    }
    const update = event.refId ? updatesById.get(event.refId) : undefined;
    if (update) {
      pdf.paragraph(`פעולות: ${update.actionsTaken}`);
      if (update.findings) pdf.paragraph(`ממצאים: ${update.findings}`);
      if (update.nextSteps) pdf.paragraph(`המשך: ${update.nextSteps}`);
    } else if (event.note) {
      pdf.paragraph(event.note);
    }
    pdf.divider();
  }

  return pdf;
}

export function incidentPdfFilename(number: string): string {
  return `תקלה-${number}.pdf`;
}
