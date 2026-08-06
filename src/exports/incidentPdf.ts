import type {
  Incident,
  IncidentCauseAssessment,
  IncidentClosureClassification,
  IncidentEvent,
  IncidentTreatmentAction,
  IncidentUpdate,
  Profile,
  SystemRecord,
  LocationRecord,
} from '../domain/types';
import { isOpen } from '../domain/types';
import {
  incidentDomainLabels,
  readinessLabels,
  reportedToOpsLabels,
  severityLabels,
  statusLabels,
  UNCLASSIFIED_DOMAIN_LABEL,
} from '../domain/labels';
import { ownerDisplay, externalHandlerDisplay } from '../components/incident';
import { formatDateTime, formatDuration } from '../lib/time';
import { HebrewPdf, type DepartmentLogo } from './pdf';
import {
  buildTimelineBlocks,
  confirmedCauseValue,
  resolutionAttributionValue,
  suspectedCauseValue,
  treatmentOutcomeValue,
} from './timelineNarrative';
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
  // Structured lifecycle classification -- entirely optional so a caller
  // (or a legacy incident with none of this data) still produces exactly
  // the same valid PDF structure as before this feature. Reuses the same
  // data IncidentDetailPage/Timeline already load; never fetched again
  // here.
  causeAssessments: IncidentCauseAssessment[] = [],
  treatmentActions: IncidentTreatmentAction[] = [],
  closures: IncidentClosureClassification[] = [],
): Promise<HebrewPdf> {
  const departmentLogos = logos.length > 0 ? logos : await loadDepartmentLogoBytes();
  const pdf = new HebrewPdf();
  const name = (id: string | null) => (id ? (profiles.find((p) => p.id === id)?.fullName ?? 'לא ידוע') : '');
  const owner = ownerDisplay(incident, profiles);
  const externalHandler = externalHandlerDisplay(incident);
  // The closure that produced the incident's CURRENT closed state -- the
  // row whose cycleNumber matches the incident's own reopenCount, exactly
  // like IncidentDetailPage's own "סיכום סגירה" block. Absent for a legacy
  // incident, or one closed through the still-permissive legacy
  // close_incident RPC without classification -- omitted identically
  // either way, never a fabricated value.
  const currentClosure = closures.find((c) => c.cycleNumber === incident.reopenCount);

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
  // Reported domain: always shown, once -- set once at creation and never
  // changed by any later event, so it never needs a timeline line too.
  pdf.field('תחום התקלה', incident.reportedDomain ? incidentDomainLabels[incident.reportedDomain] : UNCLASSIFIED_DOMAIN_LABEL);
  // Current suspected cause: only while the incident is still active
  // (isOpen also covers 'reopened') -- a closed incident's confirmed cause
  // is shown separately below, in the closure summary, and must never be
  // presented here as if it were still the current suspicion.
  if (isOpen(incident.status)) {
    pdf.field('חשד נוכחי', suspectedCauseValue(incident.currentSuspectedCause, incident.currentSuspectedCauseOtherDetail));
  }
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
    // Compact closure-classification summary, belonging to the CURRENT
    // closure cycle only -- omitted entirely (no blank rows, no invented
    // values) when no closure-classification row exists at all, exactly
    // like a true legacy closure. Every earlier cycle's own classification
    // still appears, in full, on its own closure event in the timeline
    // below -- never overwritten or reused here.
    if (currentClosure) {
      pdf.field('הגורם שאומת', confirmedCauseValue(currentClosure));
      // A small but noticeable indication for a temporary resolution --
      // the same bordered-badge treatment already used for חומרה/סטטוס
      // above, so it stands out without a second, duplicate rendering of
      // the same value.
      if (currentClosure.treatmentOutcome === 'temporary_workaround') {
        pdf.fieldBadge('תוצאת הטיפול', treatmentOutcomeValue(currentClosure));
      } else {
        pdf.field('תוצאת הטיפול', treatmentOutcomeValue(currentClosure));
      }
      pdf.field('מה ידוע על מה שהוביל לפתרון', resolutionAttributionValue(currentClosure, treatmentActions));
    }
    pdf.spacer();
  }

  pdf.sectionTitle('ציר זמן מלא');
  const blocks = buildTimelineBlocks(events, updates, profiles, causeAssessments, treatmentActions, closures);
  pdf.timelineBlocks(blocks);

  pdf.finalize();
  return pdf;
}

export function incidentPdfFilename(number: string): string {
  return `תקלה-${number}.pdf`;
}
