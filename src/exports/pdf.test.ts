import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { HebrewPdf } from './pdf';
import { DEPARTMENT_LOGOS } from '../components/DepartmentLogos';
import type { TimelineBlock } from './timelineNarrative';

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
 * Regression coverage for the RTL rendering bug: an earlier version of
 * pdf.ts pre-reversed Hebrew text before drawing it, which produced a
 * correct-looking *raster* but wrote every Hebrew word backwards into the
 * PDF's actual text content (confirmed via real copy/paste-equivalent
 * extraction while diagnosing it -- "דוח תקלה" came out as "הלקת חוד").
 *
 * These tests reconstruct exactly what ends up in the PDF's content
 * stream by observing the literal characters passed to jsPDF's `text()`
 * in draw order (see pdf.ts's drawBidiLine: a left-to-right run is drawn
 * as one call, a right-to-left run is drawn one character at a time, but
 * always walking the *logical* string forward -- never reversed). This is
 * not a re-assertion of internal bidi.ts state; it observes the same
 * primitive jsPDF itself receives, which is what a real PDF's content
 * stream/ToUnicode CMap -- and therefore copy/paste, search, and screen
 * readers -- would see.
 */
describe('drawn text is never character-reversed (regression coverage)', () => {
  function reconstruct(textSpy: { mock: { calls: unknown[][] } }): string {
    return textSpy.mock.calls.map((call) => String(call[0])).join('');
  }

  it('draws "דוח תקלה 2026-014" in its exact readable order in the incident header title', () => {
    const pdf = new HebrewPdf();
    const textSpy = vi.spyOn(pdf.doc, 'text');
    pdf.incidentHeader('2026-014', 'Martin Gusin', new Date('2026-08-01T18:00:00.000Z'), realLogos());
    const drawn = reconstruct(textSpy);
    expect(drawn).toContain('דוח תקלה 2026-014');
    // The exact bug this guards against: the old reversed-per-word output.
    expect(drawn).not.toContain('הלקת חוד');
    expect(drawn).not.toContain('חוד');
  });

  it('draws "הופק על ידי Martin Gusin" in its exact readable order in the incident header', () => {
    const pdf = new HebrewPdf();
    const textSpy = vi.spyOn(pdf.doc, 'text');
    pdf.incidentHeader('2026-014', 'Martin Gusin', new Date('2026-08-01T18:00:00.000Z'), realLogos());
    expect(reconstruct(textSpy)).toContain('הופק על ידי Martin Gusin');
  });

  it('draws each of the four section headings in exact readable order', () => {
    const expected = ['פרטי פתיחה', 'מצב נוכחי', 'פרטי סגירה', 'ציר זמן מלא'];
    for (const heading of expected) {
      const pdf = new HebrewPdf();
      pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T18:00:00.000Z'), realLogos());
      const textSpy = vi.spyOn(pdf.doc, 'text');
      pdf.sectionTitle(heading);
      const drawn = reconstruct(textSpy);
      expect(drawn).toContain(heading);
      // None of these headings' known-bad reversed forms.
      expect(drawn).not.toContain('החיתפ יטרפ');
      expect(drawn).not.toContain([...heading].reverse().join(''));
    }
  });

  it('draws "מערכת / עמדה: NET2000" with the label readable and the identifier unreversed', () => {
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T18:00:00.000Z'), realLogos());
    const textSpy = vi.spyOn(pdf.doc, 'text');
    pdf.field('מערכת / עמדה', 'NET2000');
    const drawn = reconstruct(textSpy);
    expect(drawn).toContain('מערכת / עמדה: NET2000');
    expect(drawn).not.toContain('0002TEN');
    expect(drawn).not.toContain('הדמע / תכרעמ');
  });

  it('draws "סטטוס שונה: חדשה ← בטיפול" in exact readable order for a status_change timeline title', async () => {
    const { narrativeTitle } = await import('./timelineNarrative');
    const title = narrativeTitle({
      id: 'e', incidentId: 'i', type: 'status_change', actorId: null, actorLabel: null,
      eventTime: '2026-08-01T00:00:00.000Z', serverTime: '2026-08-01T00:00:00.000Z',
      field: 'status', oldValue: 'new', newValue: 'in_progress', note: null, refId: null,
      createdAt: '2026-08-01T00:00:00.000Z', operationId: null,
    });
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T18:00:00.000Z'), realLogos());
    const textSpy = vi.spyOn(pdf.doc, 'text');
    pdf.timelineBlock({ eventTime: '2026-08-01T00:00:00.000Z', title, performer: 'בודק', tier: 'neutral', details: [] });
    const drawn = reconstruct(textSpy);
    expect(drawn).toContain('סטטוס שונה: חדשה');
    expect(drawn).toContain('בטיפול');
    expect(drawn).not.toContain('לופיטב');
    expect(drawn).not.toContain('השדח');
  });

  it('draws "התקלה נפתחה" in exact readable order for a created timeline title', async () => {
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
    const textSpy = vi.spyOn(pdf.doc, 'text');
    pdf.timelineBlock({ eventTime: '2026-08-01T00:00:00.000Z', title, performer: 'בודק', tier: 'strong', details: [] });
    const drawn = reconstruct(textSpy);
    expect(drawn).toContain('התקלה נפתחה');
    expect(drawn).not.toContain('החתפנ הלקתה');
  });

  it('keeps a composite Hebrew+English value (external handler snapshot) in exact readable order, colon adjacent to its label', () => {
    const pdf = new HebrewPdf();
    pdf.incidentHeader('2026-014', 'בודק', new Date('2026-08-01T18:00:00.000Z'), realLogos());
    const textSpy = vi.spyOn(pdf.doc, 'text');
    pdf.field('גורם מטפל חיצוני', 'Elad Levi · איש קשר: Elad Levi · פרטי קשר: elad.levi@example.com');
    const drawn = reconstruct(textSpy);
    expect(drawn).toContain('גורם מטפל חיצוני: Elad Levi · איש קשר: Elad Levi · פרטי קשר: elad.levi@example.com');
  });
});
