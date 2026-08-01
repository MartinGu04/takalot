import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { HebrewPdf } from './pdf';
import { DEPARTMENT_LOGOS } from '../components/DepartmentLogos';
import type { TimelineBlock } from './timelineNarrative';
import { extractPdfText, pdftotextAvailable } from '../test/pdftotext';

function realLogos() {
  return DEPARTMENT_LOGOS.map((logo) => ({
    key: logo.key,
    bytes: new Uint8Array(readFileSync(`public${logo.src}`)),
  }));
}

describe('Hebrew RTL PDF generation', () => {
  it('produces a valid PDF byte stream with the embedded Hebrew font', async () => {
    const pdf = new HebrewPdf();
    pdf.header('תקלה 2026-001', 'משתמש בדיקה');
    pdf.sectionTitle('פרטי פתיחה');
    pdf.field('מערכת / עמדה', 'מערכת אלפא');
    pdf.paragraph('תיאור עם טקסט מעורב: E-401, מספרים 123, וסימני פיסוק (בדיקה).');
    const blob = pdf.blob();
    expect(blob.size).toBeGreaterThan(0);
    const buf = new Uint8Array(pdf.doc.output('arraybuffer') as ArrayBuffer);
    const header = String.fromCharCode(...buf.slice(0, 5));
    expect(header).toBe('%PDF-');
  });

  it('paginates long content without throwing', () => {
    const pdf = new HebrewPdf();
    pdf.header('תקלה ארוכה', 'משתמש בדיקה');
    for (let i = 0; i < 60; i++) {
      pdf.field(`שדה ${i}`, 'ערך לדוגמה עם טקסט בעברית ותוכן ארוך יחסית לבדיקת גלישה בין עמודים');
    }
    expect(() => pdf.blob()).not.toThrow();
  });

  it('renders mixed Hebrew/English/number text via splitTextToSize without error', () => {
    const pdf = new HebrewPdf();
    pdf.header('בדיקה', 'בודק');
    expect(() =>
      pdf.paragraph(
        'מערכת Alpha-1 דיווחה קוד שגיאה E-401 בשעה 13:46, עם ערכים (12.3%) ותווים מיוחדים: /\\&.',
      ),
    ).not.toThrow();
  });
});

describe('incidentHeader', () => {
  it('draws both department logos as circular clipped images, at their exact original bytes', () => {
    const pdf = new HebrewPdf();
    const logos = realLogos();
    const circleSpy = vi.spyOn(pdf.doc, 'circle');
    const clipSpy = vi.spyOn(pdf.doc, 'clip');
    const addImageSpy = vi.spyOn(pdf.doc, 'addImage');
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T12:00:00.000Z'), logos);

    // Each logo: one circle() path for the clip, one clip() call, one
    // addImage() with the untouched original bytes, then a second circle()
    // draw for the visible border stroke -- so circle() fires twice/logo.
    expect(circleSpy).toHaveBeenCalledTimes(logos.length * 2);
    expect(clipSpy).toHaveBeenCalledTimes(logos.length);
    expect(addImageSpy).toHaveBeenCalledTimes(logos.length);
    for (const logo of logos) {
      expect(addImageSpy.mock.calls.some((call) => (call as unknown[])[0] === logo.bytes)).toBe(true);
    }
  });

  it('never draws the literal string "AVARIA" (no AVARIA wordmark/logo in the incident header)', () => {
    const pdf = new HebrewPdf();
    const textSpy = vi.spyOn(pdf.doc, 'text');
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T12:00:00.000Z'), realLogos());
    const drawnStrings = textSpy.mock.calls.map((call) => String(call[0]));
    expect(drawnStrings.some((s) => s.includes('AVARIA'))).toBe(false);
  });

  it('draws the dynamic incident number and the exporter name into the header', () => {
    const pdf = new HebrewPdf();
    const textSpy = vi.spyOn(pdf.doc, 'text');
    // An English exporter name: isolate()-wrapped LTR runs pass through
    // bidi resolution as a literal, contiguous substring (see
    // bidi.test.ts), so it -- and the incident number -- stay directly
    // findable in the drawn (resolved) strings without needing to
    // reverse-engineer Hebrew word reordering in this test.
    pdf.incidentHeader('2026-999', 'Exporter Name', new Date('2026-08-01T12:00:00.000Z'), realLogos());
    const drawnStrings = textSpy.mock.calls.map((call) => String(call[0]));
    expect(drawnStrings.some((s) => s.includes('2026-999'))).toBe(true);
    expect(drawnStrings.some((s) => s.includes('Exporter Name'))).toBe(true);
  });

  it('sets a continuation title that repeats on later pages without redrawing the logos', () => {
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T12:00:00.000Z'), realLogos());
    const addImageSpy = vi.spyOn(pdf.doc, 'addImage');
    for (let i = 0; i < 80; i += 1) {
      pdf.field(`שדה ${i}`, 'ערך לדוגמה ארוך יחסית לבדיקת גלישה בין עמודים');
    }
    expect(pdf.doc.getNumberOfPages()).toBeGreaterThan(1);
    // No logo image is drawn again once we're past page 1.
    expect(addImageSpy).not.toHaveBeenCalled();
  });
});

describe('finalize (footer + page numbers)', () => {
  it('stamps "עמוד X מתוך Y" and the AVARIA attribution line on every page, with no image beside it', () => {
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T12:00:00.000Z'), realLogos());
    for (let i = 0; i < 80; i += 1) {
      pdf.field(`שדה ${i}`, 'ערך לדוגמה ארוך יחסית לבדיקת גלישה בין עמודים');
    }
    const totalPages = pdf.doc.getNumberOfPages();
    expect(totalPages).toBeGreaterThan(1);

    const textSpy = vi.spyOn(pdf.doc, 'text');
    const addImageSpy = vi.spyOn(pdf.doc, 'addImage');
    pdf.finalize();

    const footerCalls = textSpy.mock.calls.filter((call) => String(call[0]).includes('AVARIA'));
    expect(footerCalls).toHaveLength(totalPages);
    for (let page = 1; page <= totalPages; page += 1) {
      expect(textSpy.mock.calls.some((call) => String(call[0]).includes(String(page)))).toBe(true);
    }
    expect(addImageSpy).not.toHaveBeenCalled();
  });
});

describe('fieldBadge', () => {
  it('draws a bordered box around the value next to its label', () => {
    const pdf = new HebrewPdf();
    const rectSpy = vi.spyOn(pdf.doc, 'roundedRect');
    pdf.fieldBadge('חומרה', 'גבוהה');
    expect(rectSpy).toHaveBeenCalledTimes(1);
    expect(rectSpy.mock.calls[0][6]).toBe('S');
  });
});

describe('timelineBlock pagination', () => {
  function block(overrides: Partial<TimelineBlock> = {}): TimelineBlock {
    return {
      eventTime: '2026-08-01T06:00:00.000Z',
      title: 'עדכון טיפול',
      performer: 'בודק',
      tier: 'neutral',
      details: [],
      ...overrides,
    };
  }

  it('never starts a block so close to the bottom that it would be split across pages', () => {
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T12:00:00.000Z'), realLogos());
    // Push the cursor almost to the bottom of the page.
    pdf.y = 265;
    const bigBlock = block({
      details: Array.from({ length: 12 }, (_, i) => `פרט מספר ${i} עם טקסט ארוך יחסית שגולש לשורה נוספת בבלוק`),
    });
    const rectSpy = vi.spyOn(pdf.doc, 'roundedRect');
    const pagesBefore = pdf.doc.getNumberOfPages();
    pdf.timelineBlock(bigBlock);
    const pagesAfter = pdf.doc.getNumberOfPages();

    expect(pagesAfter).toBe(pagesBefore + 1);
    // The block's own border box must be entirely on the new page: its
    // top must be at (or after) the fresh page's low y, not at the
    // cramped y=265 position it would have used had it not broken first.
    const [, top] = rectSpy.mock.calls[0];
    expect(top).toBeLessThan(50);
  });

  it('keeps a short block on the current page when it clearly fits', () => {
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T12:00:00.000Z'), realLogos());
    const pagesBefore = pdf.doc.getNumberOfPages();
    pdf.timelineBlock(block());
    expect(pdf.doc.getNumberOfPages()).toBe(pagesBefore);
  });

  function blockCountsPerPage(pdf: HebrewPdf): number[] {
    const internal = pdf.doc.internal as unknown as { pages: string[][] };
    const counts: number[] = [];
    for (let page = 1; page < internal.pages.length; page += 1) {
      counts.push((internal.pages[page].join('\n').match(/h\nB\n/g) ?? []).length);
    }
    return counts;
  }

  it('timelineBlocks spreads a trailing remainder evenly across pages instead of stranding it on a near-empty final page', () => {
    // A block with two detail lines, drawn at DETAIL_SIZE/META_SIZE/TITLE_SIZE,
    // is tall enough that ~9 of them exceed one continuation page's content
    // area (CONTENT_BOTTOM(271) - freshPageContentTop(30) = 241mm) but not by
    // much -- enough to need a second page without filling it, the exact
    // shape of the bug this guards against.
    const tallBlock = () => block({ details: ['פרט ראשון בבלוק עם טקסט', 'פרט שני בבלוק עם טקסט נוסף'] });
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T12:00:00.000Z'), realLogos());
    pdf.sectionTitle('ציר זמן מלא');
    const blocks = Array.from({ length: 20 }, tallBlock);
    pdf.timelineBlocks(blocks);

    const counts = blockCountsPerPage(pdf);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(blocks.length);
    expect(counts.length).toBeGreaterThan(1);
    const lastPageCount = counts[counts.length - 1];
    const maxOtherPage = Math.max(...counts.slice(0, -1));
    // The old greedy-until-overflow approach could leave the final page
    // with a small fraction of what a full page holds (10 vs 3, on real
    // fixture data) -- the balanced final page must hold a comparable
    // share, not a stray leftover.
    expect(lastPageCount).toBeGreaterThanOrEqual(Math.ceil(maxOtherPage / 2));
  });

  it('timelineBlocks never splits a block across pages, and never produces more pages than timelineBlock (unbalanced) would for the same content', () => {
    const blocks = Array.from({ length: 14 }, (_, i) =>
      block({ details: i % 3 === 0 ? ['פרט אחד', 'פרט שני', 'פרט שלישי'] : [] }),
    );

    const balanced = new HebrewPdf();
    balanced.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T12:00:00.000Z'), realLogos());
    balanced.sectionTitle('ציר זמן מלא');
    balanced.timelineBlocks(blocks);

    const unbalanced = new HebrewPdf();
    unbalanced.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T12:00:00.000Z'), realLogos());
    unbalanced.sectionTitle('ציר זמן מלא');
    for (const b of blocks) unbalanced.timelineBlock(b);

    expect(blockCountsPerPage(balanced).reduce((a, b) => a + b, 0)).toBe(blocks.length);
    expect(balanced.doc.getNumberOfPages()).toBeLessThanOrEqual(unbalanced.doc.getNumberOfPages());
  });
});

describe('sectionTitle orphan avoidance', () => {
  it('breaks before the heading (not after) when there is not enough room for it plus its first line', () => {
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T12:00:00.000Z'), realLogos());
    pdf.y = 265; // too little room left for a heading + any real content
    const textSpy = vi.spyOn(pdf.doc, 'text');
    const pagesBefore = pdf.doc.getNumberOfPages();
    pdf.sectionTitle('ציר זמן מלא');
    expect(pdf.doc.getNumberOfPages()).toBe(pagesBefore + 1);
    // The heading itself must have been drawn on the fresh page, i.e. at a
    // low y -- not left stranded at y≈265 on the old page.
    const headingCall = textSpy.mock.calls.find((call) => typeof call[2] === 'number' && (call[2] as number) < 50);
    expect(headingCall).toBeTruthy();
  });
});

/**
 * Regression coverage for the RTL rendering *and* extraction bugs: an
 * earlier version of pdf.ts pre-reversed Hebrew text before drawing it,
 * which produced a correct-looking *raster* but wrote every Hebrew word
 * backwards into the PDF's actual text content ("דוח תקלה" came out as
 * "הלקת חוד"); a later, still-broken version drew each Hebrew character as
 * its own separate PDF text-show operation, which fixed the reversal but
 * made real extractors read every Hebrew word with a spurious space
 * between each letter ("פ ר ט י פ ת יח ה").
 *
 * These tests validate against the actual PDF bytes via poppler's
 * pdftotext -- a real external extractor, not jsPDF's own draw calls --
 * which is the only way to catch either class of bug: jsPDF-level
 * assertions can't see content-stream-level issues like one-Tj-per-letter
 * splitting, and can't see poppler's own bidi-reconstruction quirks (a
 * misplaced ":" or "/", collapsed spaces around an unmapped glyph) either.
 * Skips (doesn't fail) when pdftotext isn't installed.
 */
describe.skipIf(!pdftotextAvailable())('drawn text is never character-reversed or split (regression coverage)', () => {
  it('extracts "דוח תקלה 2026-014" as one contiguous, correctly-ordered string from the incident header title', () => {
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'Martin Gusin', new Date('2026-08-01T18:00:00.000Z'), realLogos());
    const text = extractPdfText(pdf.outputBytes());
    expect(text).toContain('דוח תקלה 2026-014');
    // The exact bugs this guards against: word-reversal and per-letter splitting.
    expect(text).not.toContain('הלקת חוד');
    expect(text).not.toContain('ד ו ח');
  });

  it('extracts "הופק על ידי Martin Gusin" as one contiguous string, the English name unreversed', () => {
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'Martin Gusin', new Date('2026-08-01T18:00:00.000Z'), realLogos());
    const text = extractPdfText(pdf.outputBytes());
    expect(text).toContain('הופק על ידי Martin Gusin');
    expect(text).not.toContain('Gusin Martin');
  });

  it('extracts each of the four section headings as one contiguous, correctly-ordered string', () => {
    const expected = ['פרטי פתיחה', 'מצב נוכחי', 'פרטי סגירה', 'ציר זמן מלא'];
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T18:00:00.000Z'), realLogos());
    for (const heading of expected) pdf.sectionTitle(heading);
    const text = extractPdfText(pdf.outputBytes());
    for (const heading of expected) {
      expect(text).toContain(heading);
      expect(text).not.toContain([...heading].reverse().join(''));
      expect(text).not.toContain([...heading].join(' '));
    }
  });

  it('extracts "מערכת / עמדה: NET2000" as one exact contiguous string -- label, colon, and identifier all in place', () => {
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T18:00:00.000Z'), realLogos());
    pdf.field('מערכת / עמדה', 'NET2000');
    const text = extractPdfText(pdf.outputBytes());
    expect(text).toContain('מערכת / עמדה: NET2000');
    expect(text).not.toContain('0002TEN');
    expect(text).not.toContain('הדמע / תכרעמ');
  });

  it('extracts "סטטוס שונה: חדשה ← בטיפול" as one exact contiguous string, arrow included with its surrounding spaces', async () => {
    const { narrativeTitle } = await import('./timelineNarrative');
    const title = narrativeTitle({
      id: 'e', incidentId: 'i', type: 'status_change', actorId: null, actorLabel: null,
      eventTime: '2026-08-01T00:00:00.000Z', serverTime: '2026-08-01T00:00:00.000Z',
      field: 'status', oldValue: 'new', newValue: 'in_progress', note: null, refId: null,
      createdAt: '2026-08-01T00:00:00.000Z', operationId: null,
    });
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T18:00:00.000Z'), realLogos());
    pdf.timelineBlock({ eventTime: '2026-08-01T00:00:00.000Z', title, performer: 'בודק', tier: 'neutral', details: [] });
    const text = extractPdfText(pdf.outputBytes());
    expect(text).toContain('סטטוס שונה: חדשה ← בטיפול');
    expect(text).not.toContain('לופיטב');
    expect(text).not.toContain('השדח');
  });

  it('extracts "התקלה נפתחה" as one exact contiguous string for a created timeline title', async () => {
    const { narrativeTitle } = await import('./timelineNarrative');
    const title = narrativeTitle({
      id: 'e', incidentId: 'i', type: 'created', actorId: null, actorLabel: null,
      eventTime: '2026-08-01T00:00:00.000Z', serverTime: '2026-08-01T00:00:00.000Z',
      field: null, oldValue: null, newValue: null, note: null, refId: null,
      createdAt: '2026-08-01T00:00:00.000Z', operationId: null,
    });
    expect(title).toBe('התקלה נפתחה');
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T18:00:00.000Z'), realLogos());
    pdf.timelineBlock({ eventTime: '2026-08-01T00:00:00.000Z', title, performer: 'בודק', tier: 'strong', details: [] });
    const text = extractPdfText(pdf.outputBytes());
    expect(text).toContain('התקלה נפתחה');
    expect(text).not.toContain('החתפנ הלקתה');
  });

  it('extracts a date/time value in its correct order, comma directly after the date and not at the start', () => {
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T18:00:00.000Z'), realLogos());
    pdf.field('שעת גילוי', '01.08.2026, 09:15');
    const text = extractPdfText(pdf.outputBytes());
    expect(text).toContain('שעת גילוי: 01.08.2026, 09:15');
    expect(text).not.toContain(', 01.08.2026');
  });

  it('keeps a composite Hebrew+English value (external handler snapshot) readable, unreversed, and with its label directly attached', () => {
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T18:00:00.000Z'), realLogos());
    pdf.field('גורם מטפל חיצוני', 'Elad Levi · איש קשר: Elad Levi · פרטי קשר: elad.levi@example.com');
    const text = extractPdfText(pdf.outputBytes());
    expect(text).toContain('גורם מטפל חיצוני:');
    expect(text).toContain('Elad Levi');
    expect(text).toContain('איש קשר:');
    expect(text).toContain('פרטי קשר: elad.levi@example.com');
    expect(text).not.toContain('Levi Elad');
    expect(text).not.toContain('רשק שיא');
  });
});
