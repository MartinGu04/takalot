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
// date, NET2000-style identifier) draws as one normal left-to-right block.
//
// A right-to-left run is *not* drawn as separate per-character text
// objects, even though each character's position still decreases right to
// left: a real PDF text extractor (confirmed against poppler's pdftotext,
// both -raw and its default bidi-aware mode) clusters words by how many
// separate glyph-show operations it sees, not by geometry -- one Tj call
// per character reliably produced an artificial space between every
// letter ("פ ר ט י פ ת יח ה" for "פרטי פתיחה"), even when the characters
// were pixel-adjacent. drawRtlRunMerged() instead emits the whole run as
// one TJ array: one contiguous text-show operation, with per-glyph
// position adjustments computed from real glyph widths (plus a tiny,
// visually imperceptible sub-millimeter overlap margin -- empirically
// necessary because poppler's own word-clustering is sensitive to the
// sub-pixel rounding gap between jsPDF's own width measurement and the
// font's embedded CID widths; without it, otherwise pixel-perfect
// adjacency still intermittently reads as separate words). One contiguous
// operation per run is exactly what a normal, non-RTL PDF looks like to
// an extractor, so it is read back as one clean, correctly-ordered word or
// phrase, exactly like the source Hebrew.
//
// jsPDF's own RTL mechanisms are fully disabled (setR2L(false) here,
// isInputRtl:false on every text() call) so they never reprocess anything
// this file already laid out.
import { jsPDF } from 'jspdf';
import { ALEF_REGULAR_BASE64 } from './fonts/alefRegularBase64';
import { ALEF_BOLD_BASE64 } from './fonts/alefBoldBase64';
import { isolate, mirroredForRtl, resolveBidiRuns, type BidiRun } from './bidi';
import { formatDateTime } from '../lib/time';
import type { TimelineBlock } from './timelineNarrative';
import { ARROW_GLYPH_HEX, patchArrowToUnicode } from './pdfArrowGlyph';

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
  /** Set when the ← transition separator was drawn -- see pdfArrowGlyph.ts.
   *  Only then is it worth post-processing the output bytes to add its
   *  ToUnicode entry. */
  private usesArrowGlyph = false;

  constructor() {
    this.doc = new jsPDF({ unit: 'mm', format: 'a4' });
    this.doc.addFileToVFS('Alef-Regular.ttf', ALEF_REGULAR_BASE64);
    this.doc.addFont('Alef-Regular.ttf', 'Alef', 'normal');
    this.doc.addFileToVFS('Alef-Bold.ttf', ALEF_BOLD_BASE64);
    this.doc.addFont('Alef-Bold.ttf', 'Alef', 'bold');
    this.doc.setFont('Alef', 'normal');
    this.doc.setR2L(false);
  }

  /** Width a run will occupy once drawn, without actually drawing it --
   *  measured on the glyphs that will really be shown (mirrored, for an
   *  RTL run), so it agrees exactly with drawBidiLine()/drawRtlRunMerged(). */
  private measureRun(run: BidiRun): number {
    if (!run.rtl) return this.doc.getTextWidth(run.text);
    let width = 0;
    for (const ch of run.text) width += this.doc.getTextWidth(mirroredForRtl(ch));
    return width;
  }

  /** Total rendered width of `text` at the currently set font/size --
   *  needed to position/size anything (a badge box, a centered line)
   *  before actually drawing it. */
  private measureBidiLine(text: string): number {
    return resolveBidiRuns(text).reduce((sum, run) => sum + this.measureRun(run), 0);
  }

  /** The raw ops array for the page currently being drawn on -- jsPDF
   *  exposes this on `internal` but doesn't type it publicly. */
  private currentPageOps(): string[] {
    const internal = this.doc.internal as unknown as {
      pages: string[][];
      getCurrentPageInfo(): { pageNumber: number };
    };
    return internal.pages[internal.getCurrentPageInfo().pageNumber];
  }

  /** jsPDF's own correct glyph-id encoding for one character in the
   *  current font/size -- obtained by letting jsPDF draw it (a throwaway,
   *  off-page draw we immediately remove) rather than reimplementing TTF
   *  cmap lookup ourselves. The Alef font has no glyph at all for ← (see
   *  pdfArrowGlyph.ts): jsPDF itself would emit an empty, unmapped glyph
   *  for it, so it's special-cased to the reserved stand-in CID instead,
   *  which patchArrowToUnicode() (applied in blob()/outputBytes()) maps
   *  back to the real arrow for extraction. */
  private glyphHex(ch: string): string {
    if (ch === '←') {
      this.usesArrowGlyph = true;
      return ARROW_GLYPH_HEX;
    }
    const ops = this.currentPageOps();
    this.doc.text(ch, 0, 0, { align: 'left', isInputRtl: false });
    const entry = ops.pop() as string;
    return entry.match(/(<[0-9a-fA-F]+>) Tj/)?.[1] ?? '<0000>';
  }

  /**
   * Draws one right-to-left run as a single contiguous TJ text-show
   * operation -- see this file's header comment for why per-character Tj
   * calls break text extraction. `chars` are already the glyphs to draw
   * (mirrored where applicable); `rightEdge` is where the first (logically
   * first, visually rightmost) character's right edge sits. Returns the
   * run's total width.
   */
  private drawRtlRunMerged(chars: string[], rightEdge: number, y: number): number {
    const fontSizePt = this.doc.getFontSize();
    const scale = (this.doc.internal as unknown as { scaleFactor: number }).scaleFactor;
    // The ← stand-in glyph (see glyphHex/pdfArrowGlyph.ts) is a
    // deliberately out-of-range CID, absent from the embedded font
    // subset's own /W width table -- so every PDF consumer (this
    // includes poppler's own text-extraction gap/clustering heuristic,
    // not just renderers) falls back to the CIDFont's /DW default width,
    // which jsPDF sets to a full em (1000/1000 units), not the ordinary
    // Alef glyph width getTextWidth('←') measures. Using the wrong
    // (narrower) width here to cancel that glyph's real on-page advance
    // under-cancels it by the difference, silently compressing the
    // adjacent space -- confirmed empirically (via poppler) to be exactly
    // why "חדשה ← בטיפול" extracted with its surrounding spaces missing
    // even though the raster looked fine (a sub-millimeter-scale
    // compression is not visually obvious at normal viewing/print sizes).
    const emMm = fontSizePt / scale;
    const widths = chars.map((ch) => (ch === '←' ? emMm : this.doc.getTextWidth(ch)));
    const hexes = chars.map((ch) => this.glyphHex(ch));
    // A tiny, sub-millimeter, font-size-relative overlap -- invisible at
    // any normal viewing/print scale -- that makes adjacent glyphs read as
    // one continuous word instead of intermittently splitting; see header
    // comment.
    const marginMm = fontSizePt * 0.003;

    const tjParts: string[] = [];
    chars.forEach((_, i) => {
      tjParts.push(hexes[i]);
      if (i < chars.length - 1) {
        const adjustmentMm = widths[i] + widths[i + 1] + marginMm;
        const adjustmentThousandths = (adjustmentMm * scale * 1000) / fontSizePt;
        tjParts.push(adjustmentThousandths.toFixed(3));
      }
    });

    // Reuse a real jsPDF draw of the first glyph purely to steal this
    // run's exact preamble (font resource, leading, color) and correctly
    // unit-converted Y/starting-X -- avoids re-deriving jsPDF's own
    // mm-to-PDF-point conversion rules by hand.
    const ops = this.currentPageOps();
    this.doc.text(chars[0], rightEdge, y, { align: 'right', isInputRtl: false });
    const refEntry = ops.pop() as string;
    const refLines = refEntry.split('\n');
    const preamble = refLines.slice(1, -3);
    const [refX, refY] = refLines[refLines.length - 3].split(' ');

    ops.push(['BT', ...preamble, `${refX} ${refY} Td`, `[${tjParts.join(' ')}] TJ`, 'ET'].join('\n'));

    // The Alef font maps U+2190 (←, used as the timeline's "old → new"
    // transition separator) to a glyph with a real advance width but an
    // empty outline -- it draws nothing. The character stays in the text
    // layer above (so extraction/search/copy still see the real arrow,
    // per the exact required string "סטטוס שונה: חדשה ← בטיפול"); a small
    // vector arrow is drawn on top, in its slot, purely for visibility.
    let slotRight = rightEdge;
    chars.forEach((ch, i) => {
      const slotLeft = slotRight - widths[i];
      if (ch === '←') this.drawArrowGlyph(slotLeft, slotRight, y, fontSizePt);
      slotRight = slotLeft - marginMm;
    });

    return widths.reduce((a, b) => a + b, 0);
  }

  /** A small left-pointing arrow (shaft + solid head), drawn as vector
   *  shapes in the current text color, filling in for the Alef font's
   *  empty ← outline -- see drawRtlRunMerged's comment. */
  private drawArrowGlyph(slotLeft: number, slotRight: number, baselineY: number, fontSizePt: number) {
    const scale = (this.doc.internal as unknown as { scaleFactor: number }).scaleFactor;
    const emMm = fontSizePt / scale;
    const midY = baselineY - emMm * 0.32;
    const halfHeight = emMm * 0.09;
    const inset = (slotRight - slotLeft) * 0.12;
    const left = slotLeft + inset;
    const right = slotRight - inset;
    const headLength = Math.min((right - left) * 0.5, emMm * 0.22);
    const color = this.doc.getTextColor();
    this.doc.setDrawColor(color);
    this.doc.setFillColor(color);
    this.doc.setLineWidth(Math.max(emMm * 0.045, 0.12));
    this.doc.line(right, midY, left, midY);
    this.doc.triangle(left, midY, left + headLength, midY - halfHeight, left + headLength, midY + halfHeight, 'F');
  }

  /**
   * The single choke point every piece of dynamic/mixed-language text
   * draws through. `text` is ordinary logical Hebrew/English -- it is
   * never reversed here or anywhere upstream (see this file's header
   * comment and bidi.ts). Returns the line's total width.
   */
  private drawBidiLine(text: string, anchorX: number, y: number, align: 'right' | 'center' = 'right'): number {
    const runs = resolveBidiRuns(text);
    const widths = runs.map((run) => this.measureRun(run));
    const totalWidth = widths.reduce((a, b) => a + b, 0);
    let cursor = align === 'center' ? anchorX + totalWidth / 2 : anchorX;
    runs.forEach((run, i) => {
      if (run.rtl) {
        // A ":", "," or "/" inside a Hebrew run -- e.g. "מערכת / עמדה: "
        // right before "NET2000", or even a colon with plain Hebrew on
        // both sides -- gets pulled out of place (and its surrounding
        // space dropped or duplicated) on extraction, even though it is
        // drawn in exactly the right place -- confirmed directly against
        // poppler's pdftotext for every one of these separators, not just
        // at a run boundary. A zero-width RLM (U+200F, a real character
        // in the Alef font with a genuine 0-width advance -- verified,
        // not assumed) inserted right after each one gives the
        // extractor's own bidi reconstruction the same strong-RTL anchor
        // there that the surrounding Hebrew already provides visibly,
        // fixing the extracted order without moving anything on the page.
        const runText = run.text.replace(/([:,/])/g, '$1‏');
        this.drawRtlRunMerged([...runText].map(mirroredForRtl), cursor, y);
      } else {
        // The mirror case: an LTR run naming a real letter (an English
        // name) immediately followed by an RTL run starting with a
        // neutral separator (e.g. "Elad Levi · איש קשר") loses that
        // separator's surrounding spacing the same way, for the same
        // reason -- confirmed the same way. A trailing zero-width RLM
        // fixes it from this side, since the separator itself belongs to
        // the *following* run's text. Restricted to runs with a real
        // letter -- a pure-digit LTR run (a date/time value, already
        // isolated LTR for its own internal comma ordering, see bidi.ts)
        // must never sit directly next to a strong-RTL character:
        // confirmed empirically that doing so re-breaks exactly the
        // comma-ordering bug the LTR isolation was fixing, even though
        // the RLM itself is zero-width and otherwise inert.
        const nextRun = runs[i + 1];
        const runText = nextRun && nextRun.rtl && /\p{L}/u.test(run.text) ? `${run.text}‏` : run.text;
        this.doc.text(runText, cursor, y, { align: 'right', isInputRtl: false });
      }
      cursor -= widths[i];
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
   *  before this export's RTL/branding rework. Incident PDFs use
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

  /** Wraps and measures one timeline block without drawing it -- shared by
   *  timelineBlock() (single-block orphan avoidance) and timelineBlocks()
   *  (whole-section balanced pagination), so both use exactly the same
   *  height a block will actually occupy. */
  private layoutBlock(block: TimelineBlock): {
    titleLines: string[];
    metaLines: string[];
    detailLines: string[];
    height: number;
  } {
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
    return { titleLines, metaLines, detailLines, height };
  }

  /** Draws one already-laid-out block at the current y -- pure drawing, no
   *  pagination decisions (those are made by timelineBlock()/timelineBlocks()
   *  before calling this). */
  private drawLaidOutBlock(block: TimelineBlock, layout: ReturnType<typeof this.layoutBlock>) {
    const { titleLines, metaLines, detailLines, height } = layout;
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

  /** The content-area top a *fresh* continuation page will have -- without
   *  actually starting one -- used to plan pagination ahead of time. */
  private freshPageContentTop(): number {
    return this.continuationTitle ? MARGIN + 12 : MARGIN;
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
    const layout = this.layoutBlock(block);
    const availableOnPage = CONTENT_BOTTOM - this.y;
    const fullPageCapacity = CONTENT_BOTTOM - this.pageContentTop;
    const isMidPage = this.y > this.pageContentTop;
    if (layout.height > availableOnPage && layout.height <= fullPageCapacity && isMidPage) {
      this.addPage();
    }
    this.drawLaidOutBlock(block, layout);
  }

  /**
   * The whole timeline section, laid out together instead of one block at
   * a time: whatever already fits on the current page is placed exactly
   * as timelineBlock() would place it, but once the remaining blocks need
   * more than one further page, they are spread evenly across exactly as
   * many pages as they measure out to need, rather than each page being
   * packed to the brim until the last leftover blocks are stranded alone
   * on a near-empty trailing page -- confirmed against representative
   * fixture data to otherwise produce a page with barely a third of a
   * normal page's content. Never shrinks text, padding, or gaps below
   * their normal size, and never splits a block across pages -- it only
   * chooses *where* the same fixed-size blocks break across pages.
   */
  timelineBlocks(blocks: TimelineBlock[]) {
    const layouts = blocks.map((block) => this.layoutBlock(block));
    let i = 0;
    while (i < blocks.length) {
      const availableOnPage = CONTENT_BOTTOM - this.y;
      if (layouts[i].height > availableOnPage && this.y > this.pageContentTop) break;
      this.drawLaidOutBlock(blocks[i], layouts[i]);
      i += 1;
    }
    if (i >= blocks.length) return;

    const freshPageCapacity = CONTENT_BOTTOM - this.freshPageContentTop();
    const remainingHeight = layouts.slice(i).reduce((sum, l) => sum + l.height + BLOCK_GAP, 0);
    const pagesNeeded = Math.max(1, Math.ceil(remainingHeight / freshPageCapacity));

    // Each non-final page targets a *cumulative* boundary
    // (pageIndex/pagesNeeded of the total remaining height), not a fixed
    // per-page amount recomputed from zero each time -- a fixed target
    // lets small per-page leftovers silently compound into an extra,
    // near-empty page by the end (confirmed: it did, on this exact
    // fixture). The final page always takes everything left (bounded only
    // by its real capacity), so rounding never strands a small remainder
    // on a page of its own.
    let cumulative = 0;
    let pageIndex = 1;
    while (i < blocks.length) {
      this.addPage();
      const pageCapacity = CONTENT_BOTTOM - this.pageContentTop;
      const boundary = (pageIndex / pagesNeeded) * remainingHeight;
      const isFinalPage = pageIndex >= pagesNeeded;
      let pageHeight = 0;
      while (i < blocks.length) {
        const withGap = layouts[i].height + BLOCK_GAP;
        const wouldOverflowPage = pageHeight + layouts[i].height > pageCapacity;
        const wouldPassBoundary = !isFinalPage && cumulative + withGap > boundary;
        if (pageHeight > 0 && (wouldOverflowPage || wouldPassBoundary)) break;
        this.drawLaidOutBlock(blocks[i], layouts[i]);
        pageHeight += withGap;
        cumulative += withGap;
        i += 1;
      }
      pageIndex += 1;
    }
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

  /** The final PDF bytes -- always use this (or blob(), which wraps it)
   *  instead of calling `doc.output()` directly, so the ← ToUnicode patch
   *  (when the arrow was actually used) is never skipped. */
  outputBytes(): Uint8Array {
    const raw = new Uint8Array(this.doc.output('arraybuffer') as ArrayBuffer);
    return this.usesArrowGlyph ? patchArrowToUnicode(raw) : raw;
  }

  blob(): Blob {
    return new Blob([this.outputBytes() as BlobPart], { type: 'application/pdf' });
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
