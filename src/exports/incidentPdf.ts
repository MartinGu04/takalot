import type { Incident, IncidentEvent, IncidentUpdate, Profile, SystemRecord, LocationRecord } from '../domain/types';
import { readinessLabels, reportedToOpsLabels, severityLabels, statusLabels } from '../domain/labels';
import { ownerDisplay, externalHandlerDisplay } from '../components/incident';
import { formatDateTime, formatDuration } from '../lib/time';
import { HebrewPdf, type DepartmentLogo } from './pdf';
import { buildTimelineBlocks } from './timelineNarrative';
import { loadDepartmentLogoBytes } from './departmentLogos';

export async function buildIncidentPdf(
  incident: Incident,
  events: IncidentEvent[],
  updates: IncidentUpdate[],
  profiles: Profile[],
  systems: SystemRecord[],
  locations: LocationRecord[],
  exportedByName: string,
  logos: DepartmentLogo[] = [],
): Promise<HebrewPdf> {
  const departmentLogos = logos.length > 0 ? logos : await loadDepartmentLogoBytes();
  const pdf = new HebrewPdf();
  const name = (id: string | null) => (id ? (profiles.find((p) => p.id === id)?.fullName ?? 'לא ידוע') : '');
  const owner = ownerDisplay(incident, profiles);
  const externalHandler = externalHandlerDisplay(incident);

  pdf.incidentHeader(incident.number, exportedByName, new Date(), departmentLogos);

  pdf.sectionTitle('פרטי פתיחה');
  pdf.field('מספר תקלה', incident.number);
  pdf.field('מערכת / עמדה', systems.find((s) => s.id === incident.systemId)?.name ?? '');
  pdf.field('מיקום', locations.find((l) => l.id === incident.locationId)?.name ?? '');
  pdf.field('שעת גילוי', formatDateTime(incident.discoveredAt));
  pdf.field('נפתח על ידי', name(incident.createdBy));
  pdf.field('שעת פתיחה', formatDateTime(incident.createdAt));
  pdf.spacer();

  pdf.sectionTitle('מצב נוכחי');
  pdf.fieldBadge('חומרה', severityLabels[incident.severity]);
  pdf.fieldBadge('סטטוס', statusLabels[incident.status]);
  pdf.field('השפעה מבצעית', incident.operationalImpact);
  pdf.field('בעל אחריות פנימי', owner);
  if (externalHandler) pdf.field('גורם מטפל חיצוני', externalHandler);
  pdf.field(
    'דווח למבצעים',
    incident.reportedToOps === 'yes' && incident.reportedToOpsRecipient
      ? `${reportedToOpsLabels[incident.reportedToOps]} — ${incident.reportedToOpsRecipient}`
      : reportedToOpsLabels[incident.reportedToOps],
  );
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
  const blocks = buildTimelineBlocks(events, updates, profiles);
  for (const block of blocks) {
    pdf.timelineBlock(block);
  }

  pdf.finalize();
  return pdf;
}

export function incidentPdfFilename(number: string): string {
  return `תקלה-${number}.pdf`;
}
