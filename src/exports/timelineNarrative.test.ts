import { describe, expect, it } from 'vitest';
import { buildTimelineBlocks, narrativeTitle } from './timelineNarrative';
import type { IncidentEvent, IncidentUpdate, Profile } from '../domain/types';
import {
  fixtureEvents,
  fixtureProfiles,
  fixtureUpdate,
} from './fixtures/incidentPdfFixture';

const RAW_TOKENS = [
  'status:',
  'in_progress',
  'reported_to_ops_recipient',
  'owner:',
  'external_handler',
  'operational_impact',
  'true',
  'false',
  '"',
  '{',
  '}',
  'null',
];

function allText(blocks: ReturnType<typeof buildTimelineBlocks>): string {
  return blocks.map((b) => [b.title, b.performer, ...b.details].join('\n')).join('\n');
}

describe('buildTimelineBlocks (fixture)', () => {
  const blocks = buildTimelineBlocks(fixtureEvents, [fixtureUpdate], fixtureProfiles);

  it('produces one block per timeline event (fixture has no grouped operations)', () => {
    expect(blocks).toHaveLength(fixtureEvents.length);
  });

  it('never contains raw database field names, enum values, or booleans', () => {
    const text = allText(blocks);
    for (const token of RAW_TOKENS) {
      expect(text).not.toContain(token);
    }
  });

  it('never contains yes/no literals in place of translated labels', () => {
    const text = allText(blocks);
    expect(text).not.toMatch(/\byes\b/);
    expect(text).not.toMatch(/\bno\b/);
  });

  it('renders the status change with Hebrew status labels, not raw enum values', () => {
    const block = blocks.find((b) => b.title.startsWith('סטטוס שונה'));
    expect(block?.title).toContain('חדשה');
    expect(block?.title).toContain('בטיפול');
  });

  it('renders the internal owner change by name', () => {
    const block = blocks.find((b) => b.title.includes('בעל האחריות הפנימי'));
    expect(block?.title).toContain('רועי כהן');
  });

  it('renders the external handler change with the English performer name intact', () => {
    const block = blocks.find((b) => b.title.includes('הגורם המטפל החיצוני'));
    expect(block?.title).toContain('Elad Levi');
  });

  it('renders the reporting recipient update and its later cancellation with the required phrasing', () => {
    const updated = blocks.find((b) => b.title.includes('הנמען לדיווח למבצעים עודכן'));
    expect(updated?.title).toContain('אילון');
    const cancelled = blocks.find((b) => b.title === 'הדיווח למבצעים בוטל');
    expect(cancelled).toBeTruthy();
  });

  it('renders the treatment update with its structured fields, human-labeled', () => {
    const block = blocks.find((b) => b.title === 'עדכון טיפול');
    expect(block?.performer).toBe('אילון ברק');
    const text = block?.details.join('\n') ?? '';
    expect(text).toContain('בוצעה בדיקת חומרה');
    expect(text).toContain('דווח למבצעים בעדכון זה: כן');
    expect(text).toContain('אילון');
  });

  it('renders reopening and closure with human phrasing and closure readiness', () => {
    const reopened = blocks.find((b) => b.title === 'התקלה נפתחה מחדש');
    expect(reopened?.details.join('\n')).toContain('נדרשת בדיקה חוזרת');
    const closed = blocks.find((b) => b.title === 'התקלה נסגרה');
    const closedText = closed?.details.join('\n') ?? '';
    expect(closedText).toContain('כשירות בסגירה: מלאה');
    expect(closedText).toContain('סיבת התקלה');
  });

  it('falls back to a safe generic title for an unrecognized event type, without dumping its raw metadata', () => {
    const block = blocks.find((b) => b.eventTime === '2026-08-01T08:00:00.000Z');
    expect(block?.title).toBe('אירוע מערכת');
    const text = block?.details.join('\n') ?? '';
    expect(text).not.toContain('some_internal_column');
    expect(text).not.toContain('waiting_external');
  });
});

describe('narrativeTitle', () => {
  const base: IncidentEvent = {
    id: 'e',
    incidentId: 'i',
    type: 'status_change',
    actorId: null,
    actorLabel: null,
    eventTime: '2026-08-01T00:00:00.000Z',
    serverTime: '2026-08-01T00:00:00.000Z',
    field: null,
    oldValue: null,
    newValue: null,
    note: null,
    userNote: null,
    refId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    operationId: null,
  };

  it('never renders a raw severity enum value', () => {
    const title = narrativeTitle({ ...base, type: 'severity_change', field: 'severity', oldValue: 'low', newValue: 'critical' });
    expect(title).toContain('נמוכה');
    expect(title).toContain('קריטית');
    expect(title).not.toContain('low');
    expect(title).not.toContain('critical');
  });

  it('falls back to a safe generic title for a completely unknown type with no crash', () => {
    const title = narrativeTitle({ ...base, type: 'made_up_future_type' as IncidentEvent['type'] });
    expect(title).toBe('אירוע מערכת');
  });
});

describe('actor resolution', () => {
  it('prefers actorLabel, then profile lookup, then a system fallback', () => {
    const profiles: Profile[] = [
      { id: 'p1', fullName: 'שם מלא', role: 'technician', active: true, createdAt: '2025-01-01T00:00:00.000Z' },
    ];
    const events: IncidentEvent[] = [
      { id: '1', incidentId: 'i', type: 'created', actorId: null, actorLabel: 'גורם חיצוני', eventTime: '2026-08-01T00:00:00.000Z', serverTime: '2026-08-01T00:00:00.000Z', field: null, oldValue: null, newValue: null, note: null, userNote: null, refId: null, createdAt: '2026-08-01T00:00:00.000Z', operationId: null },
      { id: '2', incidentId: 'i', type: 'acknowledged', actorId: 'p1', actorLabel: null, eventTime: '2026-08-01T00:01:00.000Z', serverTime: '2026-08-01T00:01:00.000Z', field: null, oldValue: null, newValue: null, note: null, userNote: null, refId: null, createdAt: '2026-08-01T00:01:00.000Z', operationId: null },
      { id: '3', incidentId: 'i', type: 'follow_up_completed', actorId: null, actorLabel: null, eventTime: '2026-08-01T00:02:00.000Z', serverTime: '2026-08-01T00:02:00.000Z', field: null, oldValue: null, newValue: null, note: null, userNote: null, refId: null, createdAt: '2026-08-01T00:02:00.000Z', operationId: null },
    ];
    const blocks = buildTimelineBlocks(events, [], profiles);
    expect(blocks[0].performer).toBe('גורם חיצוני');
    expect(blocks[1].performer).toBe('שם מלא');
    expect(blocks[2].performer).toBe('המערכת');
  });
});

describe('IncidentUpdate boolean/enum reporting fields never leak raw values', () => {
  it('translates updateReportedToComms/updateWisdomReported booleans to כן/לא', () => {
    const update: IncidentUpdate = {
      ...fixtureUpdate,
      id: 'u2',
      updateReportedToOps: 'no',
      updateReportedToOpsRecipient: null,
      updateReportedToComms: true,
      updateReportedToCommsRecipient: 'דוברות',
      updateWisdomReported: true,
    };
    const event: IncidentEvent = {
      id: 'e2',
      incidentId: 'i',
      type: 'update',
      actorId: null,
      actorLabel: 'בודק',
      eventTime: '2026-08-01T00:00:00.000Z',
      serverTime: '2026-08-01T00:00:00.000Z',
      field: null,
      oldValue: null,
      newValue: null,
      note: null,
      userNote: null,
      refId: 'u2',
      createdAt: '2026-08-01T00:00:00.000Z',
      operationId: null,
    };
    const [block] = buildTimelineBlocks([event], [update], []);
    const text = block.details.join('\n');
    expect(text).toContain('דווח למבצעים בעדכון זה: לא');
    expect(text).toContain('דווח לתקשוב למבצעים בעדכון זה: כן');
    expect(text).toContain('עודכן ב-WISDOM בעדכון זה: כן');
    expect(text).not.toMatch(/\btrue\b/);
    expect(text).not.toMatch(/\bfalse\b/);
  });
});
