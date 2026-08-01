// Hebrew RTL PDF engine built on jsPDF with the embedded, permissively licensed
// Alef font (SIL OFL — see public/fonts/OFL-Alef.txt).
//
// RTL/bidi handling: jsPDF ships two different, uncoordinated RTL
// mechanisms (a legacy setR2L/R2L full-string reversal, and a separate
// isInputRtl-driven "BidiEngine"), and both of them -- and an earlier
// version of this file -- work by physically reversing the Hebrew
// character array before drawing it as a plain left-to-right run. That
// makes the *raster* look right when eyeballed, but corrupts the PDF's
// actual text content: every glyph gets its own ToUnicode entry, so a
// reversed draw order writes each Hebrew word backwards into the content
// stream. Copy-pasting, searching, or reading the document with assistive
// technology then sees "חוד" where it should read "דוח" -- confirmed
// empirically while fixing this.
//
// The fix (see src/exports/bidi.ts): every character is drawn in its
// ordinary logical order -- never reversed -- and only its *position*
// varies. bidi.ts's resolveBidiRuns() splits a line into direction runs,
// in logical order; drawBidiLine() below walks those runs from a
// right-hand anchor moving leftward: a left-to-right run (English name,
// date, NET2000-style identifier) draws as one normal left-to-right block,
// a right-to-left run draws character-by-character, each successive
// character placed further left -- so the content stream always matches
// the real text, and the raster still reads correctly right-to-left.
// jsPDF's own RTL mechanisms are fully disabled (setR2L(false) here,
// isInputRtl:false on every text() call) so they never reprocess anything
// this file already laid out.
import { jsPDF } from 'jspdf';
import { ALEF_REGULAR_BASE64 } from './fonts/alefRegularBase64';
import { ALEF_BOLD_BASE64 } from './fonts/alefBoldBase64';
import { isolate, mirroredForRtl, resolveBidiRuns, type BidiRun } from './bidi';
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

  private runWidths(runs: BidiRun[]): number[] {
    return runs.map((run) => this.doc.getTextWidth(run.text));
  }

  /** Total rendered width of `text` at the currently set font/size --
   *  needed to position/size anything (a badge box, a centered line)
   *  before actually drawing it. */
  private measureBidiLine(text: string): number {
    return this.runWidths(resolveBidiRuns(text)).reduce((a, b) => a + b, 0);
  }

  /**
   * The single choke point every piece of dynamic/mixed-language text
   * draws through. `text` is ordinary logical Hebrew/English -- it is
   * never reversed here or anywhere upstream (see this file's header
   * comment and bidi.ts). Returns the line's total width.
   */
  private drawBidiLine(text: string, anchorX: number, y: number, align: 'right' | 'center' = 'right'): number {
    const runs = resolveBidiRuns(text);
    const widths = this.runWidths(runs);
    const totalWidth = widths.reduce((a, b) => a + b, 0);
    let cursor = align === 'center' ? anchorX + totalWidth / 2 : anchorX;
    runs.forEach((run, i) => {
      if (run.rtl) {
        for (const ch of run.text) {
          const w = this.doc.getTextWidth(ch);
          this.doc.text(mirroredForRtl(ch), cursor, y, { align: 'right', isInputRtl: false });
          cursor -= w;
        }
      } else {
        this.doc.text(run.text, cursor, y, { align: 'right', isInputRtl: false });
        cursor -= widths[i];
      }
    });
    return totalWidth;
  }

  private addPage() {
    this.doc.addPage();
    this.y = MARGIN;
    if (this.continuationTitle) {
      this.doc.setFont('Alef', 'normal');
      this.doc.setFontSize(9);
      this.doc.setTextColor(130);
      this.drawBidiLine(this.continuationTitle, PAGE_WIDTH - MARGIN, this.y + 4);
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
    this.doc.setFontSize(16);
    this.drawBidiLine('AVARIA', PAGE_WIDTH - MARGIN, this.y);
    this.y += 8;
    this.doc.setFontSize(13);
    this.drawBidiLine(title, PAGE_WIDTH - MARGIN, this.y);
    this.y += 6;
    this.doc.setFont('Alef', 'normal');
    this.doc.setFontSize(9);
    this.doc.setTextColor(110);
    this.drawBidiLine(
      `הופק על ידי ${isolate(exportedBy)} · ${isolate(formatDateTime(new Date().toISOString()))}`,
      PAGE_WIDTH - MARGIN,
      this.y,
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
    this.doc.setFontSize(18);
    this.drawBidiLine(`דוח תקלה ${isolate(incidentNumber)}`, centerX, this.y, 'center');
    this.y += 8;

    this.doc.setFont('Alef', 'normal');
    this.doc.setFontSize(10);
    this.doc.setTextColor(110);
    this.drawBidiLine(
      `יוצא ${isolate(formatDateTime(exportedAt.toISOString()))} · הופק על ידי ${isolate(exportedByName)}`,
      centerX,
      this.y,
      'center',
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
    this.doc.setFontSize(12.5);
    this.drawBidiLine(text, PAGE_WIDTH - MARGIN, this.y);
    this.y += 5.5;
    this.doc.setDrawColor(210);
    this.doc.line(MARGIN, this.y, PAGE_WIDTH - MARGIN, this.y);
    this.y += 5;
    this.doc.setFont('Alef', 'normal');
  }

  /** Label: value line, wraps long values. The value is always isolated
   *  (see bidi.ts) so its own run boundary never depends on, and never
   *  bleeds into, the label/punctuation around it -- correct whether the
   *  value is Hebrew, an English name, a date, or an identifier. */
  field(label: string, value: string) {
    const text = `${label}: ${value ? isolate(value) : '—'}`;
    this.doc.setFont('Alef', 'normal');
    this.doc.setFontSize(10);
    const lines = this.doc.splitTextToSize(text, CONTENT_WIDTH) as string[];
    this.ensureSpace(lines.length * 5.2);
    for (const line of lines) {
      this.drawBidiLine(line, PAGE_WIDTH - MARGIN, this.y);
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
    const labelText = `${label}: `;
    const labelWidth = this.drawBidiLine(labelText, PAGE_WIDTH - MARGIN, this.y + 3.6);
    this.doc.setFont('Alef', 'bold');
    this.doc.setFontSize(9);
    const badgeValue = isolate(value);
    const textWidth = this.measureBidiLine(badgeValue);
    const paddingX = 2.6;
    const badgeWidth = textWidth + paddingX * 2;
    const badgeRight = PAGE_WIDTH - MARGIN - labelWidth - 2;
    this.doc.setDrawColor(120);
    this.doc.setLineWidth(0.25);
    this.doc.roundedRect(badgeRight - badgeWidth, this.y, badgeWidth, 5.4, 1, 1, 'S');
    this.drawBidiLine(badgeValue, badgeRight - badgeWidth / 2, this.y + 3.7, 'center');
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
      this.drawBidiLine(line, PAGE_WIDTH - MARGIN, this.y);
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
    this.doc.setFontSize(TITLE_SIZE);
    for (const line of titleLines) {
      this.drawBidiLine(line, PAGE_WIDTH - MARGIN - BLOCK_PADDING, cursorY);
      cursorY += 5.4;
    }
    this.doc.setFont('Alef', 'normal');
    this.doc.setFontSize(META_SIZE);
    this.doc.setTextColor(120);
    for (const line of metaLines) {
      this.drawBidiLine(line, PAGE_WIDTH - MARGIN - BLOCK_PADDING, cursorY);
      cursorY += 4.2;
    }
    this.doc.setTextColor(60);
    this.doc.setFontSize(DETAIL_SIZE);
    if (detailLines.length > 0) cursorY += 2;
    for (const line of detailLines) {
      this.drawBidiLine(line, PAGE_WIDTH - MARGIN - BLOCK_PADDING, cursorY);
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
      this.doc.setFontSize(8);
      this.doc.setTextColor(130);
      this.drawBidiLine(
        `עמוד ${isolate(String(page))} מתוך ${isolate(String(total))} · הופק באמצעות AVARIA`,
        PAGE_WIDTH / 2,
        FOOTER_TEXT_Y,
        'center',
      );
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
