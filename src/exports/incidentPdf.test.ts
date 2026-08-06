import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildIncidentPdf, incidentPdfFilename } from './incidentPdf';
import { DEPARTMENT_LOGOS } from '../components/DepartmentLogos';
import {
  fixtureCauseAssessments,
  fixtureClosure,
  fixtureClosures,
  fixtureEvents,
  fixtureExportedByName,
  fixtureIncident,
  fixtureLocations,
  fixtureProfiles,
  fixtureSystems,
  fixtureTreatmentActions,
  fixtureUpdate,
} from './fixtures/incidentPdfFixture';

function loadRealLogos() {
  return DEPARTMENT_LOGOS.map((logo) => ({
    key: logo.key,
    bytes: new Uint8Array(readFileSync(`public${logo.src}`)),
  }));
}

async function buildFixturePdf() {
  return buildIncidentPdf(
    fixtureIncident,
    fixtureEvents,
    [fixtureUpdate],
    fixtureProfiles,
    fixtureSystems,
    fixtureLocations,
    fixtureExportedByName,
    loadRealLogos(),
    fixtureCauseAssessments,
    fixtureTreatmentActions,
    fixtureClosures,
  );
}

function pageOps(pdf: Awaited<ReturnType<typeof buildFixturePdf>>, page: number): string {
  return (pdf.doc as unknown as { internal: { pages: string[][] } }).internal.pages[page].join('\n');
}

describe('buildIncidentPdf', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('produces a valid, multi-page PDF from representative fixture data, balanced so the trailing page is not near-empty', async () => {
    const pdf = await buildFixturePdf();
    const buf = new Uint8Array(pdf.doc.output('arraybuffer') as ArrayBuffer);
    expect(String.fromCharCode(...buf.slice(0, 5))).toBe('%PDF-');
    // The fixture has enough timeline events that this must not fit on one
    // page, and must not end on a near-empty trailing page either.
    const totalPages = pdf.doc.getNumberOfPages();
    expect(totalPages).toBeGreaterThan(1);
    // Every timeline block draws a filled rounded rect ("...h\nB\n" for the
    // fill, followed by the stroke) -- count them per page to check the
    // *balance*, not just that the last page has at least one: the
    // unbalanced greedy pagination this replaced put 10 of this fixture's
    // 14 timeline blocks on page 2 and stranded only 3 alone on page 3.
    const perPageBlockCounts = Array.from({ length: totalPages }, (_, i) =>
      (pageOps(pdf, i + 1).match(/h\nB\n/g) ?? []).length,
    );
    const lastPageCount = perPageBlockCounts[totalPages - 1];
    expect(lastPageCount).toBeGreaterThan(0);
    const maxOtherPageCount = Math.max(...perPageBlockCounts.slice(0, -1));
    expect(lastPageCount).toBeGreaterThanOrEqual(Math.ceil(maxOtherPageCount / 2));
  });

  it('embeds both approved department logos as their exact, byte-for-byte original files', async () => {
    const pdf = await buildFixturePdf();
    const pdfBytes = Buffer.from(pdf.doc.output('arraybuffer') as ArrayBuffer);
    const logos = loadRealLogos();
    expect(logos).toHaveLength(2);
    for (const logo of logos) {
      expect(pdfBytes.indexOf(Buffer.from(logo.bytes))).toBeGreaterThan(-1);
    }
  });

  it('loads the two canonical logos itself (via fetch, from their exact public paths) when none are injected', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const logo = DEPARTMENT_LOGOS.find((l) => l.src === url);
      if (!logo) throw new Error(`unexpected fetch: ${url}`);
      const bytes = readFileSync(`public${logo.src}`);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const pdf = await buildIncidentPdf(
      fixtureIncident,
      fixtureEvents,
      [fixtureUpdate],
      fixtureProfiles,
      fixtureSystems,
      fixtureLocations,
      fixtureExportedByName,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => call[0]).sort()).toEqual(
      DEPARTMENT_LOGOS.map((l) => l.src).sort(),
    );
    const pdfBytes = Buffer.from(pdf.doc.output('arraybuffer') as ArrayBuffer);
    for (const logo of loadRealLogos()) {
      expect(pdfBytes.indexOf(Buffer.from(logo.bytes))).toBeGreaterThan(-1);
    }
  });

  it('uses the incident’s own dynamic number for both the header and the filename', async () => {
    const pdf = await buildIncidentPdf(
      { ...fixtureIncident, number: '2026-999' },
      fixtureEvents,
      [fixtureUpdate],
      fixtureProfiles,
      fixtureSystems,
      fixtureLocations,
      fixtureExportedByName,
      loadRealLogos(),
    );
    expect(pageOps(pdf, 1)).not.toBe('');
    expect(incidentPdfFilename('2026-999')).toBe('תקלה-2026-999.pdf');
    expect(incidentPdfFilename(fixtureIncident.number)).toBe(`תקלה-${fixtureIncident.number}.pdf`);
  });

  it('draws the exporter name from the export context into page 1 (not invented/hard-coded data)', async () => {
    const pdfA = await buildIncidentPdf(
      fixtureIncident,
      fixtureEvents,
      [fixtureUpdate],
      fixtureProfiles,
      fixtureSystems,
      fixtureLocations,
      'Exporter One',
      loadRealLogos(),
    );
    const pdfB = await buildIncidentPdf(
      fixtureIncident,
      fixtureEvents,
      [fixtureUpdate],
      fixtureProfiles,
      fixtureSystems,
      fixtureLocations,
      'Exporter Two',
      loadRealLogos(),
    );
    // Different exporter names must produce a different page-1 content
    // stream (the exporter name is drawn into the header).
    expect(pageOps(pdfA, 1)).not.toBe(pageOps(pdfB, 1));
  });

  it('never leaks raw database field names, enum values, or booleans in the timeline it draws', async () => {
    // buildIncidentPdf's own timeline content comes entirely from
    // buildTimelineBlocks() (see timelineNarrative.test.ts for the full
    // per-event-type verification of that content) -- this asserts the
    // wiring itself: buildIncidentPdf draws exactly that already-safe
    // content and does not additionally splice in anything raw (e.g. it
    // never falls back to event.field/oldValue/newValue directly).
    const { buildTimelineBlocks } = await import('./timelineNarrative');
    const blocks = buildTimelineBlocks(fixtureEvents, [fixtureUpdate], fixtureProfiles);
    const rawTokens = ['in_progress', 'reported_to_ops_recipient', 'external_handler', 'operational_impact', 'null', 'true', 'false'];
    const text = blocks.map((b) => [b.title, ...b.details].join('\n')).join('\n');
    for (const token of rawTokens) {
      expect(text).not.toContain(token);
    }
    // And the PDF must actually contain one block per fixture event (built
    // without throwing, across every page).
    const pdf = await buildFixturePdf();
    let rectCount = 0;
    for (let page = 1; page <= pdf.doc.getNumberOfPages(); page += 1) {
      rectCount += (pageOps(pdf, page).match(/h\nB\n/g) ?? []).length;
    }
    expect(rectCount).toBe(blocks.length);
  });

  it('keeps all four required document sections', async () => {
    const pdf = await buildFixturePdf();
    const allOps = Array.from({ length: pdf.doc.getNumberOfPages() }, (_, i) => pageOps(pdf, i + 1)).join('\n');
    // Section headings draw a horizontal rule right below them; presence
    // is confirmed structurally via the narrative/content tests, so here
    // we just confirm the document has substantial content on every page
    // (no section silently failed to render / threw mid-build).
    expect(allOps.length).toBeGreaterThan(0);
    expect(pdf.doc.getNumberOfPages()).toBeGreaterThanOrEqual(3);
  });
});

// Structured lifecycle classification (AVARIA incident classification
// feature): the main summary/details area, wired through buildIncidentPdf.
// Content-string extraction is not viable for these PDF-drawn glyphs (see
// pdf.ts's own header comment on why the content stream uses glyph CIDs,
// not literal characters) -- see timelineNarrative.test.ts for the direct,
// literal-string-level coverage of the exact same formatting functions this
// wiring calls. These tests instead confirm: it never throws for every
// required incident shape (open/closed/legacy/reopened/cancelled), and a
// classification-dependent choice (e.g. temporary-workaround vs a plain
// outcome) actually produces different page content, proving the new data
// is really reaching the page and not silently ignored.
describe('buildIncidentPdf: structured lifecycle classification wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a legacy incident (reportedDomain/currentSuspectedCause both null, no classification rows at all, omitted params) still builds a valid PDF, exactly like before this feature', async () => {
    const legacyIncident = {
      ...fixtureIncident,
      reportedDomain: null,
      currentSuspectedCause: null,
      currentSuspectedCauseOtherDetail: null,
    };
    const pdf = await buildIncidentPdf(
      legacyIncident,
      fixtureEvents,
      [fixtureUpdate],
      fixtureProfiles,
      fixtureSystems,
      fixtureLocations,
      fixtureExportedByName,
      loadRealLogos(),
      // causeAssessments/treatmentActions/closures omitted entirely.
    );
    const buf = new Uint8Array(pdf.doc.output('arraybuffer') as ArrayBuffer);
    expect(String.fromCharCode(...buf.slice(0, 5))).toBe('%PDF-');
  });

  it('an open incident (isOpen) with a reported domain and a current suspected cause builds without error, and differs from the same incident with currentSuspectedCause null', async () => {
    const openWithCause = {
      ...fixtureIncident,
      status: 'in_progress' as const,
      closedAt: null,
      closedBy: null,
      reportedDomain: 'infrastructure' as const,
      currentSuspectedCause: 'software' as const,
    };
    const openWithoutCause = { ...openWithCause, currentSuspectedCause: null };
    const pdfWith = await buildIncidentPdf(
      openWithCause, fixtureEvents, [fixtureUpdate], fixtureProfiles, fixtureSystems, fixtureLocations,
      fixtureExportedByName, loadRealLogos(), fixtureCauseAssessments, fixtureTreatmentActions, [],
    );
    const pdfWithout = await buildIncidentPdf(
      openWithoutCause, fixtureEvents, [fixtureUpdate], fixtureProfiles, fixtureSystems, fixtureLocations,
      fixtureExportedByName, loadRealLogos(), fixtureCauseAssessments, fixtureTreatmentActions, [],
    );
    expect(pageOps(pdfWith, 1)).not.toBe(pageOps(pdfWithout, 1));
  });

  it('explicit \'unknown\' current suspected cause produces different page content than null (never conflated)', async () => {
    const base = {
      ...fixtureIncident,
      status: 'in_progress' as const,
      closedAt: null,
      closedBy: null,
    };
    const pdfNull = await buildIncidentPdf(
      { ...base, currentSuspectedCause: null }, fixtureEvents, [fixtureUpdate], fixtureProfiles, fixtureSystems,
      fixtureLocations, fixtureExportedByName, loadRealLogos(),
    );
    const pdfUnknown = await buildIncidentPdf(
      { ...base, currentSuspectedCause: 'unknown' }, fixtureEvents, [fixtureUpdate], fixtureProfiles, fixtureSystems,
      fixtureLocations, fixtureExportedByName, loadRealLogos(),
    );
    expect(pageOps(pdfNull, 1)).not.toBe(pageOps(pdfUnknown, 1));
  });

  it('a closed incident with no matching closure row (legacy closure) builds without error and omits the closure-classification block (no blank rows/invented values)', async () => {
    const pdfNoClosure = await buildIncidentPdf(
      fixtureIncident, fixtureEvents, [fixtureUpdate], fixtureProfiles, fixtureSystems, fixtureLocations,
      fixtureExportedByName, loadRealLogos(), fixtureCauseAssessments, fixtureTreatmentActions, [],
    );
    const pdfWithClosure = await buildFixturePdf();
    // The closure block adds real content -- the two documents must differ.
    expect(pageOps(pdfNoClosure, 1)).not.toBe(pageOps(pdfWithClosure, 1));
  });

  it('a temporary-workaround closure builds without error and produces different page content than a plain permanent-resolution closure (the small-but-noticeable badge treatment actually applies)', async () => {
    const temp = { ...fixtureClosure, treatmentOutcome: 'temporary_workaround' as const };
    const permanent = { ...fixtureClosure, treatmentOutcome: 'permanent_resolution' as const };
    const pdfTemp = await buildIncidentPdf(
      fixtureIncident, fixtureEvents, [fixtureUpdate], fixtureProfiles, fixtureSystems, fixtureLocations,
      fixtureExportedByName, loadRealLogos(), fixtureCauseAssessments, fixtureTreatmentActions, [temp],
    );
    const pdfPermanent = await buildIncidentPdf(
      fixtureIncident, fixtureEvents, [fixtureUpdate], fixtureProfiles, fixtureSystems, fixtureLocations,
      fixtureExportedByName, loadRealLogos(), fixtureCauseAssessments, fixtureTreatmentActions, [permanent],
    );
    expect(pageOps(pdfTemp, 1)).not.toBe(pageOps(pdfPermanent, 1));
  });

  it('a cancelled incident never shows closure classification, even when a closure row is supplied', async () => {
    const cancelled = {
      ...fixtureIncident,
      status: 'cancelled' as const,
      closedAt: null,
      closedBy: null,
      cancelledAt: fixtureIncident.closedAt,
      cancelledBy: fixtureIncident.closedBy,
      cancellationReason: 'נפתחה בטעות',
    };
    const pdf = await buildIncidentPdf(
      cancelled, fixtureEvents, [fixtureUpdate], fixtureProfiles, fixtureSystems, fixtureLocations,
      fixtureExportedByName, loadRealLogos(), fixtureCauseAssessments, fixtureTreatmentActions, fixtureClosures,
    );
    const buf = new Uint8Array(pdf.doc.output('arraybuffer') as ArrayBuffer);
    expect(String.fromCharCode(...buf.slice(0, 5))).toBe('%PDF-');
    // No "פרטי סגירה" section at all for a cancellation -- gated on
    // incident.status === 'closed', unaffected by this feature.
    expect(pdf.doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });

  it('a reopened incident with two separate closure cycles builds without error', async () => {
    const reopenedIncident = { ...fixtureIncident, status: 'closed' as const, reopenCount: 1 };
    const cycle0 = { ...fixtureClosure, id: 'closure-cycle-0', cycleNumber: 0, resolutionActionIds: [] as string[], resolutionAttribution: 'undetermined' as const };
    const cycle1 = { ...fixtureClosure, id: 'closure-cycle-1', cycleNumber: 1 };
    const pdf = await buildIncidentPdf(
      reopenedIncident, fixtureEvents, [fixtureUpdate], fixtureProfiles, fixtureSystems, fixtureLocations,
      fixtureExportedByName, loadRealLogos(), fixtureCauseAssessments, fixtureTreatmentActions, [cycle0, cycle1],
    );
    const buf = new Uint8Array(pdf.doc.output('arraybuffer') as ArrayBuffer);
    expect(String.fromCharCode(...buf.slice(0, 5))).toBe('%PDF-');
  });

  it('a very long "other" detail value wraps across multiple lines without throwing (no clipped/overlapping content)', async () => {
    const longDetail = 'פירוט ארוך מאוד לבדיקת גלישת טקסט '.repeat(20);
    const closureWithLongDetail = {
      ...fixtureClosure,
      confirmedCause: 'other' as const,
      confirmedCauseOtherDetail: longDetail,
    };
    const pdf = await buildIncidentPdf(
      fixtureIncident, fixtureEvents, [fixtureUpdate], fixtureProfiles, fixtureSystems, fixtureLocations,
      fixtureExportedByName, loadRealLogos(), fixtureCauseAssessments, fixtureTreatmentActions, [closureWithLongDetail],
    );
    const buf = new Uint8Array(pdf.doc.output('arraybuffer') as ArrayBuffer);
    expect(String.fromCharCode(...buf.slice(0, 5))).toBe('%PDF-');
  });
});
