import type { Handover, HandoverAddendum, HandoverItem, Profile } from '../domain/types';
import { severityLabels, statusLabels } from '../domain/labels';
import { formatDateTime } from '../lib/time';
import { HebrewPdf } from './pdf';

export function buildHandoverPdf(
  handover: Handover,
  items: HandoverItem[],
  addenda: HandoverAddendum[],
  profiles: Profile[],
  exportedByName: string,
): HebrewPdf {
  const pdf = new HebrewPdf();
  const name = (id: string) => profiles.find((p) => p.id === id)?.fullName ?? 'משתמש';

  pdf.header('העברת משמרת', exportedByName);
  pdf.sectionTitle('פרטי ההעברה');
  pdf.field('נמסר על ידי', name(handover.createdBy));
  pdf.field('מתקבל אצל', name(handover.toUserId));
  pdf.field('שעת יצירה', formatDateTime(handover.createdAt));
  pdf.field('מצב', handover.status === 'accepted' ? 'אושרה' : 'ממתינה לאישור');
  if (handover.acceptedAt) pdf.field('שעת אישור', formatDateTime(handover.acceptedAt));
  if (handover.generalNote) pdf.field('הערה כללית', handover.generalNote);
  pdf.spacer();

  pdf.sectionTitle(`תקלות בהעברה (${items.length})`);
  for (const item of items) {
    pdf.field('תקלה', `${item.snapshotNumber} — ${item.snapshotSystemName} / ${item.snapshotLocationName}`);
    pdf.field('חומרה / סטטוס', `${severityLabels[item.snapshotSeverity]} · ${statusLabels[item.snapshotStatus]}`);
    pdf.field('גורם מטפל', item.snapshotOwnerLabel);
    pdf.field('פעולה אחרונה', item.snapshotLastAction || '—');
    pdf.field('פעולת המשך', item.snapshotNextSteps || '—');
    pdf.field('צפי לעדכון הבא', item.snapshotNextUpdateDue ? formatDateTime(item.snapshotNextUpdateDue) : 'ללא צפי');
    if (item.note) pdf.field('הערת מסירה', item.note);
    pdf.divider();
  }

  if (addenda.length > 0) {
    pdf.sectionTitle('תוספות');
    for (const a of addenda) {
      pdf.field(name(a.authorId), formatDateTime(a.createdAt));
      pdf.paragraph(a.text);
    }
  }

  return pdf;
}

export function handoverPdfFilename(handover: Handover): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(handover.createdAt));
  return `העברת-משמרת-${date}.pdf`;
}
