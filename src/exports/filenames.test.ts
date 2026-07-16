// Filename generation is verified directly here because headless Chromium in
// this sandbox cannot report non-Latin `download` attribute values through
// Playwright's suggestedFilename() API (confirmed independent of this app:
// even a bare "א.csv" blob download is reported back as literal "download").
// The e2e suite therefore verifies exported file *content*, while this test
// verifies the exact Hebrew file names the spec requires.
import { describe, expect, it } from 'vitest';
import { incidentsExportFilename } from './table';
import { incidentPdfFilename } from './incidentPdf';
import { handoverPdfFilename } from './handoverPdf';
import type { Handover } from '../domain/types';

describe('export file names', () => {
  it('names a single-incident PDF תקלה-<number>.pdf', () => {
    expect(incidentPdfFilename('2026-001')).toBe('תקלה-2026-001.pdf');
  });

  it('names a date-ranged filtered export תקלות-<from>-עד-<to>.<ext>', () => {
    const from = '2026-07-01T00:00:00.000Z';
    const to = '2026-07-31T20:00:00.000Z';
    expect(incidentsExportFilename('xlsx', from, to)).toBe('תקלות-2026-07-01-עד-2026-07-31.xlsx');
    expect(incidentsExportFilename('csv', from, to)).toBe('תקלות-2026-07-01-עד-2026-07-31.csv');
  });

  it('falls back to today\'s date when no range is given', () => {
    const name = incidentsExportFilename('xlsx');
    expect(name).toMatch(/^תקלות-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it('names a handover PDF with its creation date', () => {
    const handover: Handover = {
      id: 'h1',
      createdBy: 'u1',
      createdAt: '2026-07-16T10:00:00.000Z',
      toUserId: 'u2',
      generalNote: '',
      status: 'pending',
      acceptedAt: null,
      acceptedBy: null,
    };
    expect(handoverPdfFilename(handover)).toMatch(/^העברת-משמרת-2026-07-16\.pdf$/);
  });
});
