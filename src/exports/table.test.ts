import { describe, expect, it } from 'vitest';
import { incidentsToCsv, incidentsToXlsxBlob, INCIDENT_EXPORT_HEADERS } from './table';
import type { Incident } from '../domain/types';

function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'i1',
    number: '2026-001',
    version: 1,
    systemId: 'sys-alpha',
    locationId: 'loc-1',
    description: 'תקלה עם תיאור פנימי בלבד (לא מיוצא)',
    severity: 'critical',
    status: 'in_progress',
    operationalImpact: 'השפעה עם "מרכאות", פסיקים, ומספרים 123 ותווית ASCII-1',
    ownerUserId: null,
    ownerExternalName: 'טכנאי חיצוני',
    discoveredAt: '2026-07-16T10:00:00.000Z',
    createdAt: '2026-07-16T10:05:00.000Z',
    createdBy: 'u1',
    updatedAt: '2026-07-16T10:05:00.000Z',
    updatedBy: 'u1',
    lastUpdateAt: '2026-07-16T10:05:00.000Z',
    nextUpdateDue: '2026-07-16T14:00:00.000Z',
    noDeadlineReason: null,
    reportedToOps: 'yes',
    closedAt: null,
    closedBy: null,
    rootCause: null,
    resolution: null,
    readinessAtClose: null,
    followUpNotes: null,
    followUpRequired: false,
    followUpCompletedAt: null,
    followUpCompletedBy: null,
    reopenCount: 0,
    ...overrides,
  };
}

const ctx = { profiles: [], systems: [{ id: 'sys-alpha', name: 'מערכת אלפא', archived: false, createdAt: '' }], locations: [{ id: 'loc-1', name: 'אתר 1', archived: false, createdAt: '' }], now: new Date('2026-07-16T12:00:00.000Z') };

describe('CSV Hebrew export encoding', () => {
  it('starts with a UTF-8 BOM so Excel renders Hebrew correctly', () => {
    const csv = incidentsToCsv([makeIncident()], ctx);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('includes the required Hebrew column headers in order', () => {
    const csv = incidentsToCsv([makeIncident()], ctx);
    const headerLine = csv.slice(1).split('\r\n')[0];
    for (const header of INCIDENT_EXPORT_HEADERS) {
      expect(headerLine).toContain(header);
    }
  });

  it('escapes fields containing quotes and commas', () => {
    const csv = incidentsToCsv([makeIncident()], ctx);
    expect(csv).toContain('""מרכאות""');
  });

  it('preserves mixed Hebrew/ASCII/number content without corruption', () => {
    const csv = incidentsToCsv([makeIncident()], ctx);
    expect(csv).toContain('מערכת אלפא');
    expect(csv).toContain('ASCII-1');
    expect(csv).toContain('123');
  });

  it('produces an empty (header-only) CSV for zero matching rows without throwing', () => {
    const csv = incidentsToCsv([], ctx);
    const lines = csv.slice(1).split('\r\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('מספר תקלה');
  });
});

describe('XLSX export', () => {
  it('produces a non-empty spreadsheet blob for representative rows', () => {
    const blob = incidentsToXlsxBlob([makeIncident()], ctx);
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toContain('spreadsheetml');
  });

  it('does not throw for zero matching rows', () => {
    expect(() => incidentsToXlsxBlob([], ctx)).not.toThrow();
  });

  it('handles very long descriptions without truncation error', () => {
    const long = makeIncident({ description: 'א'.repeat(3900) });
    expect(() => incidentsToXlsxBlob([long], ctx)).not.toThrow();
  });
});
