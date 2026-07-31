// Filtered incidents export: XLSX + UTF-8 CSV with BOM (reliable Hebrew in Excel).
import * as XLSX from 'xlsx';
import type { Incident, LocationRecord, Profile, SystemRecord } from '../domain/types';
import {
  readinessLabels,
  reportedToOpsLabels,
  severityLabels,
  statusLabels,
} from '../domain/labels';
import { ownerDisplay, externalHandlerDisplay } from '../components/incident';
import { formatDateTime, formatDuration } from '../lib/time';

export interface ExportContext {
  profiles: Profile[];
  systems: SystemRecord[];
  locations: LocationRecord[];
  now: Date;
}

export const INCIDENT_EXPORT_HEADERS = [
  'מספר תקלה',
  'זמן פתיחה',
  'זמן גילוי',
  'מערכת / עמדה',
  'מיקום',
  'חומרה',
  'סטטוס',
  'השפעה מבצעית',
  'בעל אחריות פנימי',
  'גורם מטפל חיצוני',
  'עדכון אחרון',
  'דווח למבצעים',
  'זמן סגירה',
  'משך התקלה',
  'סיבת התקלה',
  'הפתרון שבוצע',
  'כשירות בסגירה',
  'פעולות המשך',
  'נפתח על ידי',
  'נסגר על ידי',
] as const;

export function incidentToExportRow(incident: Incident, ctx: ExportContext): string[] {
  const name = (id: string | null) => (id ? (ctx.profiles.find((p) => p.id === id)?.fullName ?? '') : '');
  return [
    incident.number,
    formatDateTime(incident.createdAt),
    formatDateTime(incident.discoveredAt),
    ctx.systems.find((s) => s.id === incident.systemId)?.name ?? '',
    ctx.locations.find((l) => l.id === incident.locationId)?.name ?? '',
    severityLabels[incident.severity],
    statusLabels[incident.status],
    incident.operationalImpact,
    ownerDisplay(incident, ctx.profiles),
    externalHandlerDisplay(incident) ?? '',
    formatDateTime(incident.lastUpdateAt),
    reportedToOpsLabels[incident.reportedToOps],
    incident.closedAt ? formatDateTime(incident.closedAt) : '',
    incident.closedAt ? formatDuration(incident.discoveredAt, incident.closedAt) : '',
    incident.rootCause ?? '',
    incident.resolution ?? '',
    incident.readinessAtClose ? readinessLabels[incident.readinessAtClose] : '',
    incident.followUpNotes ?? '',
    name(incident.createdBy),
    name(incident.closedBy),
  ];
}

/** UTF-8 CSV with BOM so Excel opens Hebrew correctly. */
export function incidentsToCsv(incidents: Incident[], ctx: ExportContext): string {
  const escape = (v: string) => {
    if (/[",\n\r]/.test(v)) return '"' + v.replaceAll('"', '""') + '"';
    return v;
  };
  const lines = [
    INCIDENT_EXPORT_HEADERS.map(escape).join(','),
    ...incidents.map((i) => incidentToExportRow(i, ctx).map(escape).join(',')),
  ];
  return '﻿' + lines.join('\r\n');
}

export function incidentsToXlsxBlob(incidents: Incident[], ctx: ExportContext): Blob {
  const rows = [
    [...INCIDENT_EXPORT_HEADERS] as string[],
    ...incidents.map((i) => incidentToExportRow(i, ctx)),
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = INCIDENT_EXPORT_HEADERS.map((_, idx) => ({ wch: idx === 7 || idx === 16 || idx === 17 ? 40 : 18 }));
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, ws, 'תקלות');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** File name like תקלות-2026-07-01-עד-2026-07-31.xlsx */
export function incidentsExportFilename(ext: 'xlsx' | 'csv', from?: string, to?: string): string {
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(iso));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  if (from && to) return `תקלות-${fmt(from)}-עד-${fmt(to)}.${ext}`;
  return `תקלות-${today}.${ext}`;
}
