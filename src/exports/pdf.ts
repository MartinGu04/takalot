// Hebrew RTL PDF engine built on jsPDF with the embedded, permissively licensed
// Alef font (SIL OFL — see public/fonts/OFL-Alef.txt). jsPDF's native RTL
// support (isInputRtl + setR2L) handles correct visual ordering.
import { jsPDF } from 'jspdf';
import { ALEF_REGULAR_BASE64 } from './fonts/alefRegularBase64';
import { ALEF_BOLD_BASE64 } from './fonts/alefBoldBase64';
import { APP_NAME } from '../domain/labels';
import { formatDateTime } from '../lib/time';

const PAGE_WIDTH = 210;
const MARGIN = 18;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

export class HebrewPdf {
  doc: jsPDF;
  y = MARGIN;

  constructor() {
    this.doc = new jsPDF({ unit: 'mm', format: 'a4' });
    this.doc.addFileToVFS('Alef-Regular.ttf', ALEF_REGULAR_BASE64);
    this.doc.addFont('Alef-Regular.ttf', 'Alef', 'normal');
    this.doc.addFileToVFS('Alef-Bold.ttf', ALEF_BOLD_BASE64);
    this.doc.addFont('Alef-Bold.ttf', 'Alef', 'bold');
    this.doc.setFont('Alef', 'normal');
    this.doc.setR2L(true);
  }

  private ensureSpace(lines = 1, lineHeight = 6) {
    if (this.y + lines * lineHeight > 285) {
      this.doc.addPage();
      this.y = MARGIN;
    }
  }

  header(title: string, exportedBy: string) {
    this.doc.setFont('Alef', 'bold');
    this.doc.setFontSize(16);
    this.doc.text(APP_NAME, PAGE_WIDTH - MARGIN, this.y, { align: 'right', isInputRtl: true });
    this.y += 8;
    this.doc.setFontSize(13);
    this.doc.text(title, PAGE_WIDTH - MARGIN, this.y, { align: 'right', isInputRtl: true });
    this.y += 6;
    this.doc.setFont('Alef', 'normal');
    this.doc.setFontSize(9);
    this.doc.setTextColor(110);
    this.doc.text(
      `הופק על ידי ${exportedBy} · ${formatDateTime(new Date().toISOString())}`,
      PAGE_WIDTH - MARGIN,
      this.y,
      { align: 'right', isInputRtl: true },
    );
    this.doc.setTextColor(0);
    this.y += 4;
    this.doc.setDrawColor(200);
    this.doc.line(MARGIN, this.y, PAGE_WIDTH - MARGIN, this.y);
    this.y += 8;
  }

  sectionTitle(text: string) {
    this.ensureSpace(2);
    this.doc.setFont('Alef', 'bold');
    this.doc.setFontSize(12);
    this.doc.text(text, PAGE_WIDTH - MARGIN, this.y, { align: 'right', isInputRtl: true });
    this.y += 6;
    this.doc.setFont('Alef', 'normal');
  }

  /** Label: value line, wraps long values. */
  field(label: string, value: string) {
    this.doc.setFontSize(10);
    const text = `${label}: ${value || '—'}`;
    const lines = this.doc.splitTextToSize(text, CONTENT_WIDTH) as string[];
    this.ensureSpace(lines.length);
    for (const line of lines) {
      this.doc.text(line, PAGE_WIDTH - MARGIN, this.y, { align: 'right', isInputRtl: true });
      this.y += 5.2;
    }
  }

  paragraph(text: string) {
    this.doc.setFontSize(10);
    const lines = this.doc.splitTextToSize(text || '—', CONTENT_WIDTH) as string[];
    this.ensureSpace(lines.length);
    for (const line of lines) {
      this.doc.text(line, PAGE_WIDTH - MARGIN, this.y, { align: 'right', isInputRtl: true });
      this.y += 5.2;
    }
    this.y += 2;
  }

  spacer(mm = 3) {
    this.y += mm;
  }

  divider() {
    this.ensureSpace(1);
    this.doc.setDrawColor(225);
    this.doc.line(MARGIN, this.y, PAGE_WIDTH - MARGIN, this.y);
    this.y += 5;
  }

  blob(): Blob {
    return this.doc.output('blob');
  }
}

export function downloadPdf(pdf: HebrewPdf, filename: string) {
  const url = URL.createObjectURL(pdf.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
