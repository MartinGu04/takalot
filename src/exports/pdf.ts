// Hebrew RTL PDF engine built on jsPDF with the embedded, permissively licensed
// Alef font (SIL OFL — see public/fonts/OFL-Alef.txt).
//
// RTL/bidi handling: jsPDF ships two different, uncoordinated RTL
// mechanisms (a legacy setR2L/R2L full-string reversal, and a separate
// isInputRtl-driven "BidiEngine"). Enabling both together -- as this file
// used to, via setR2L(true) + isInputRtl:true on every call -- works only
// for simple single-script lines; for anything mixing Hebrew with an
// embedded LTR run (an English name, a date, an identifier like NET2000),
// passing a string through jsPDF's own bidi handling reorders it, and
// passing that already-reordered string through a *second* jsPDF call
// (or the wrong flag combination) reorders it again, corrupting the
// result. This was confirmed empirically while building this file: feeding
// jsPDF a pre-resolved string with isInputRtl left at its default silently
// re-reversed embedded digits (see bidi.ts's module comment).
//
// The fix: do bidi resolution exactly once, ourselves, with the
// spec-conformant bidi-js implementation (src/exports/bidi.ts), and then
// hand jsPDF the already-correct left-to-right glyph sequence with BOTH of
// its own RTL mechanisms turned off (setR2L(false) here, isInputRtl:false
// on every text() call below) so it never reprocesses it.
import { jsPDF } from 'jspdf';
import { ALEF_REGULAR_BASE64 } from './fonts/alefRegularBase64';
import { ALEF_BOLD_BASE64 } from './fonts/alefBoldBase64';
import { isolate, resolveBidiVisual } from './bidi';
import { formatDateTime } from '../lib/time';
import type { TimelineBlock } from './timelineNarrative';

const PAGE_WIDTH = 210;
const MARGIN = 18;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
// Reserves room below the last content line for the footer (page number +
// "הופק באמצעות AVARIA"), so the footer never overlaps document content.
const CONTENT_BOTTOM = 271;
const FOOTER_RULE_Y = 280;
const FOOTER_TEXT_Y = 286;

const LOGO_DIAMETER = 22;
const LOGO_GAP = 6;

const BLOCK_PADDING = 3.2;
const BLOCK_GAP = 4;
const TITLE_SIZE = 11;
const META_SIZE = 8.5;
const DETAIL_SIZE = 9.3;

export interface DepartmentLogo {
  bytes: Uint8Array;
  key: string;
}

export class HebrewPdf {
  doc: jsPDF;
  y = MARGIN;
  /** y at which the current page's content area begins (right after the
   *  page's own header/continuation-header), used to tell "an oversized
   *  block that can never fit on any page" apart from "doesn't fit in the
   *  remaining space on this page". */
  private pageContentTop = MARGIN;
  /** Set once by incidentHeader(); redrawn as a small running header at the
   *  top of every subsequent page so essential document context (which
   *  incident this is) survives pagination without repeating the logos --
   *  see incidentHeader's own comment. */
  private continuationTitle: string | null = null;

  constructor() {
    this.doc = new jsPDF({ unit: 'mm', format: 'a4' });
    this.doc.addFileToVFS('Alef-Regular.ttf', ALEF_REGULAR_BASE64);
    this.doc.addFont('Alef-Regular.ttf', 'Alef', 'normal');
    this.doc.addFileToVFS('Alef-Bold.ttf', ALEF_BOLD_BASE64);
    this.doc.addFont('Alef-Bold.ttf', 'Alef', 'bold');
    this.doc.setFont('Alef', 'normal');
    this.doc.setR2L(false);
  }

  /** The single choke point every piece of dynamic/mixed-language text
   *  must go through: resolves true bidi visual order, then draws with
   *  jsPDF's own RTL handling fully disabled (see file header comment). */
  private drawRtl(text: string, x: number, y: number, opts: { fontSize: number; align?: 'right' | 'center' } = { fontSize: 10 }) {
    this.doc.setFontSize(opts.fontSize);
    this.doc.text(resolveBidiVisual(text), x, y, { align: opts.align ?? 'right', isInputRtl: false });
  }

  private addPage() {
    this.doc.addPage();
    this.y = MARGIN;
    if (this.continuationTitle) {
      this.doc.setFont('Alef', 'normal');
      this.doc.setTextColor(130);
      this.drawRtl(this.continuationTitle, PAGE_WIDTH - MARGIN, this.y + 4, { fontSize: 9 });
      this.doc.setTextColor(0);
      this.doc.setDrawColor(220);
      this.doc.line(MARGIN, this.y + 7, PAGE_WIDTH - MARGIN, this.y + 7);
      this.y += 12;
    }
    this.pageContentTop = this.y;
  }

  private ensureSpace(estimatedHeight: number) {
    if (this.y + estimatedHeight > CONTENT_BOTTOM) {
      this.addPage();
    }
  }

  /** Generic document header (title + "exported by/at"), unchanged from
   *  before this export's RTL/branding rework -- still used by the
   *  handover PDF export, out of scope for this change. Incident PDFs use
   *  incidentHeader() instead. */
  header(title: string, exportedBy: string) {
    this.doc.setFont('Alef', 'bold');
    this.drawRtl('AVARIA', PAGE_WIDTH - MARGIN, this.y, { fontSize: 16 });
    this.y += 8;
    this.drawRtl(title, PAGE_WIDTH - MARGIN, this.y, { fontSize: 13 });
    this.y += 6;
    this.doc.setFont('Alef', 'normal');
    this.doc.setTextColor(110);
    this.drawRtl(
      `הופק על ידי ${isolate(exportedBy)} · ${isolate(formatDateTime(new Date().toISOString()))}`,
      PAGE_WIDTH - MARGIN,
      this.y,
      { fontSize: 9 },
    );
    this.doc.setTextColor(0);
    this.y += 4;
    this.doc.setDrawColor(200);
    this.doc.line(MARGIN, this.y, PAGE_WIDTH - MARGIN, this.y);
    this.y += 8;
    this.pageContentTop = this.y;
  }

  /** Draws one logo, exactly as supplied, contained (never cropped, never
   *  stretched -- aspect ratio preserved) inside a circular clip that
   *  removes only the source image's square corners. */
  private drawCircularLogo(logo: DepartmentLogo, cx: number, cy: number, diameter: number) {
    const props = this.doc.getImageProperties(logo.bytes);
    const radius = diameter / 2;
    const scale = Math.min(diameter / props.width, diameter / props.height);
    const w = props.width * scale;
    const h = props.height * scale;
    this.doc.saveGraphicsState();
    this.doc.circle(cx, cy, radius, null);
    this.doc.clip();
    this.doc.discardPath();
    this.doc.addImage(logo.bytes, props.fileType, cx - w / 2, cy - h / 2, w, h);
    this.doc.restoreGraphicsState();
    this.doc.setDrawColor(190);
    this.doc.setLineWidth(0.25);
    this.doc.circle(cx, cy, radius, 'S');
  }

  /**
   * First-page masthead: the two approved department logos side by side
   * (replacing the AVARIA wordmark -- no AVARIA logo or symbol appears in
   * this header), the incident number, and export context. Sets a small
   * running header that repeats "דוח תקלה <number>" on every later page
   * (without the logos, which stay first-page-only) so the document stays
   * identifiable after pagination.
   */
  incidentHeader(incidentNumber: string, exportedByName: string, exportedAt: Date, logos: DepartmentLogo[]) {
    const centerX = PAGE_WIDTH / 2;
    const pairWidth = logos.length * LOGO_DIAMETER + Math.max(0, logos.length - 1) * LOGO_GAP;
    let cx = centerX - pairWidth / 2 + LOGO_DIAMETER / 2;
    const logoCenterY = this.y + LOGO_DIAMETER / 2;
    for (const logo of logos) {
      this.drawCircularLogo(logo, cx, logoCenterY, LOGO_DIAMETER);
      cx += LOGO_DIAMETER + LOGO_GAP;
    }
    this.y += LOGO_DIAMETER + 8;

    this.doc.setFont('Alef', 'bold');
    this.drawRtl(`דוח תקלה ${isolate(incidentNumber)}`, centerX, this.y, { fontSize: 18, align: 'center' });
    this.y += 8;

    this.doc.setFont('Alef', 'normal');
    this.doc.setTextColor(110);
    this.drawRtl(
      `יוצא ${isolate(formatDateTime(exportedAt.toISOString()))} · הופק על ידי ${isolate(exportedByName)}`,
      centerX,
      this.y,
      { fontSize: 10, align: 'center' },
    );
    this.doc.setTextColor(0);
    this.y += 6;
    this.doc.setDrawColor(200);
    this.doc.line(MARGIN, this.y, PAGE_WIDTH - MARGIN, this.y);
    this.y += 9;

    this.continuationTitle = `דוח תקלה ${incidentNumber} (המשך)`;
    this.pageContentTop = this.y;
  }

  /** Section heading with a small look-ahead reserve so a heading is never
   *  left alone at the bottom of a page (it always breaks together with at
   *  least the start of its own content). */
  sectionTitle(text: string) {
    this.ensureSpace(18);
    this.doc.setFont('Alef', 'bold');
    this.drawRtl(text, PAGE_WIDTH - MARGIN, this.y, { fontSize: 12.5 });
    this.y += 5.5;
    this.doc.setDrawColor(210);
    this.doc.line(MARGIN, this.y, PAGE_WIDTH - MARGIN, this.y);
    this.y += 5;
    this.doc.setFont('Alef', 'normal');
  }

  /** Label: value line, wraps long values. The value is always isolated
   *  (see bidi.ts) so its own internal order never depends on, and never
   *  leaks into, the label/punctuation around it -- correct whether the
   *  value is Hebrew, an English name, a date, or an identifier. */
  field(label: string, value: string) {
    const text = `${label}: ${value ? isolate(value) : '—'}`;
    this.doc.setFont('Alef', 'normal');
    this.doc.setFontSize(10);
    const lines = this.doc.splitTextToSize(text, CONTENT_WIDTH) as string[];
    this.ensureSpace(lines.length * 5.2);
    for (const line of lines) {
      this.drawRtl(line, PAGE_WIDTH - MARGIN, this.y, { fontSize: 10 });
      this.y += 5.2;
    }
  }

  /** A field rendered as a small bordered badge next to its label instead
   *  of plain text -- used for status/severity so they read as a formal
   *  document's classification marks rather than body copy. Neutral
   *  border-only styling: legible in color and in grayscale/print. */
  fieldBadge(label: string, value: string) {
    this.doc.setFont('Alef', 'normal');
    this.doc.setFontSize(10);
    this.ensureSpace(6.5);
    const labelWithColon = `${label}: `;
    this.drawRtl(labelWithColon, PAGE_WIDTH - MARGIN, this.y + 3.6, { fontSize: 10 });
    const labelWidth = this.doc.getTextWidth(resolveBidiVisual(labelWithColon));
    this.doc.setFont('Alef', 'bold');
    this.doc.setFontSize(9);
    const badgeText = resolveBidiVisual(isolate(value));
    const textWidth = this.doc.getTextWidth(badgeText);
    const paddingX = 2.6;
    const badgeWidth = textWidth + paddingX * 2;
    const badgeRight = PAGE_WIDTH - MARGIN - labelWidth - 2;
    this.doc.setDrawColor(120);
    this.doc.setLineWidth(0.25);
    this.doc.roundedRect(badgeRight - badgeWidth, this.y, badgeWidth, 5.4, 1, 1, 'S');
    this.doc.text(badgeText, badgeRight - badgeWidth / 2, this.y + 3.7, { align: 'center', isInputRtl: false });
    this.doc.setFont('Alef', 'normal');
    this.y += 8;
  }

  /** Pre-composed text (already containing any isolate() markers it
   *  needs) -- used for narrative sentences that are not a simple
   *  label/value pair. Unlike field(), does not isolate the whole string:
   *  the caller has already isolated whichever embedded parts need it. */
  paragraph(text: string) {
    this.doc.setFont('Alef', 'normal');
    this.doc.setFontSize(10);
    const lines = this.doc.splitTextToSize(text || '—', CONTENT_WIDTH) as string[];
    this.ensureSpace(lines.length * 5.2);
    for (const line of lines) {
      this.drawRtl(line, PAGE_WIDTH - MARGIN, this.y, { fontSize: 10 });
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

  private wrapAt(text: string, width: number, fontSize: number, weight: 'normal' | 'bold'): string[] {
    this.doc.setFont('Alef', weight);
    this.doc.setFontSize(fontSize);
    return this.doc.splitTextToSize(text, width) as string[];
  }

  /**
   * One timeline event as a distinct, bordered block (event time, title,
   * performer, structured details) -- never split across pages when it can
   * be avoided: its height is measured up front, and a page break happens
   * *before* the block (not mid-block) if it would not otherwise fit. A
   * block taller than a full page's content area is drawn as-is (nothing
   * to avoid there -- it will not fit on any single page).
   */
  timelineBlock(block: TimelineBlock) {
    const innerWidth = CONTENT_WIDTH - BLOCK_PADDING * 2;
    const titleLines = this.wrapAt(block.title, innerWidth, TITLE_SIZE, 'bold');
    const metaText = `${isolate(formatDateTime(block.eventTime))} · בוצע על ידי ${isolate(block.performer)}`;
    const metaLines = this.wrapAt(metaText, innerWidth, META_SIZE, 'normal');
    const detailLineGroups = block.details.map((detail) => this.wrapAt(`–  ${detail}`, innerWidth, DETAIL_SIZE, 'normal'));
    const detailLines = detailLineGroups.flat();

    const height =
      BLOCK_PADDING * 2 +
      titleLines.length * 5.4 +
      metaLines.length * 4.2 +
      (detailLines.length > 0 ? 2 + detailLines.length * 4.3 : 0);

    const availableOnPage = CONTENT_BOTTOM - this.y;
    const fullPageCapacity = CONTENT_BOTTOM - this.pageContentTop;
    const isMidPage = this.y > this.pageContentTop;
    if (height > availableOnPage && height <= fullPageCapacity && isMidPage) {
      this.addPage();
    }

    const top = this.y;
    const fillShade = block.tier === 'strong' ? 250 : 252;
    this.doc.setDrawColor(215);
    this.doc.setFillColor(fillShade, fillShade, fillShade);
    this.doc.setLineWidth(block.tier === 'strong' ? 0.4 : 0.2);
    this.doc.roundedRect(MARGIN, top, CONTENT_WIDTH, height, 1.5, 1.5, 'FD');

    let cursorY = top + BLOCK_PADDING + 3.4;
    this.doc.setFont('Alef', 'bold');
    for (const line of titleLines) {
      this.drawRtl(line, PAGE_WIDTH - MARGIN - BLOCK_PADDING, cursorY, { fontSize: TITLE_SIZE });
      cursorY += 5.4;
    }
    this.doc.setFont('Alef', 'normal');
    this.doc.setTextColor(120);
    for (const line of metaLines) {
      this.drawRtl(line, PAGE_WIDTH - MARGIN - BLOCK_PADDING, cursorY, { fontSize: META_SIZE });
      cursorY += 4.2;
    }
    this.doc.setTextColor(60);
    if (detailLines.length > 0) cursorY += 2;
    for (const line of detailLines) {
      this.drawRtl(line, PAGE_WIDTH - MARGIN - BLOCK_PADDING, cursorY, { fontSize: DETAIL_SIZE });
      cursorY += 4.3;
    }
    this.doc.setTextColor(0);

    this.y = top + height + BLOCK_GAP;
  }

  /** Stamps the footer (page number + attribution line -- no AVARIA logo
   *  or symbol) on every page. Call once, after all content has been
   *  added, so the total page count is known. */
  finalize() {
    const total = this.doc.getNumberOfPages();
    for (let page = 1; page <= total; page += 1) {
      this.doc.setPage(page);
      this.doc.setDrawColor(225);
      this.doc.line(MARGIN, FOOTER_RULE_Y, PAGE_WIDTH - MARGIN, FOOTER_RULE_Y);
      this.doc.setFont('Alef', 'normal');
      this.doc.setTextColor(130);
      this.drawRtl(`עמוד ${isolate(String(page))} מתוך ${isolate(String(total))} · הופק באמצעות AVARIA`, PAGE_WIDTH / 2, FOOTER_TEXT_Y, {
        fontSize: 8,
        align: 'center',
      });
      this.doc.setTextColor(0);
    }
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
