import { describe, expect, it } from 'vitest';
import {
  buildTimelineBlocks,
  confirmedCauseValue,
  narrativeTitle,
  resolutionAttributionValue,
  suspectedCauseValue,
  treatmentActionListValue,
  treatmentOutcomeValue,
} from './timelineNarrative';
import type {
  IncidentClosureClassification,
  IncidentEvent,
  IncidentTreatmentAction,
  IncidentUpdate,
  Profile,
} from '../domain/types';
import {
  fixtureCauseAssessments,
  fixtureClosures,
  fixtureEvents,
  fixtureInitialTreatmentAction,
  fixtureProfiles,
  fixtureTreatmentActions,
  fixtureUpdate,
  fixtureUpdateTreatmentAction,
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

// Structured lifecycle classification (AVARIA incident classification
// feature, PDF export): buildTimelineBlocks joins causeAssessments/
// treatmentActions (by operationId) and closures (by the 'closed' event's
// refId) onto exactly the event they belong to -- never a separate block,
// never leaking a raw enum/null/undefined, and never repeating the SAME
// closure's classification on more than one closure event.
describe('buildTimelineBlocks: structured lifecycle classification', () => {
  const CLASSIFICATION_RAW_TOKENS = [
    'equipment', 'software', 'communications', 'infrastructure', 'operational', 'external', 'unknown', 'other',
    'diagnosis', 'reset_restart', 'equipment_replacement', 'config_change', 'software_fix',
    'communications_handling', 'infrastructure_handling', 'external_party_handling',
    'undetermined', 'no_action_taken', 'external_party_no_details', 'specific_action', 'combination_of_actions',
    'permanent_resolution', 'temporary_workaround', 'not_reproduced', 'resolved_without_action',
    'closed_without_technical_resolution',
    'null', 'undefined', 'true', 'false',
  ];

  it('never leaks a raw enum value, null, or undefined anywhere in the classification-aware output (fixture, all event types combined)', () => {
    const blocks = buildTimelineBlocks(
      fixtureEvents,
      [fixtureUpdate],
      fixtureProfiles,
      fixtureCauseAssessments,
      fixtureTreatmentActions,
      fixtureClosures,
    );
    const text = allText(blocks);
    for (const token of CLASSIFICATION_RAW_TOKENS) {
      expect(text).not.toMatch(new RegExp(`\\b${token}\\b`));
    }
  });

  it('renders the initial suspected cause and initial structured actions on the CREATED block, with wording that never claims a fabricated action time', () => {
    const blocks = buildTimelineBlocks(
      fixtureEvents,
      [fixtureUpdate],
      fixtureProfiles,
      fixtureCauseAssessments,
      fixtureTreatmentActions,
      fixtureClosures,
    );
    const created = blocks.find((b) => b.title === 'התקלה נפתחה');
    const text = created?.details.join('\n') ?? '';
    expect(text).toContain('חשד ראשוני: ציוד או חומרה — תועד בעת פתיחת התקלה');
    expect(text).toContain('פעולות שסווגו בעת הפתיחה: בדיקה או אבחון');
  });

  it('renders a compact "פעולות טיפול:" line on the UPDATE block for structured actions recorded during that update, without repeating the free-text actionsTaken wording', () => {
    const blocks = buildTimelineBlocks(
      fixtureEvents,
      [fixtureUpdate],
      fixtureProfiles,
      fixtureCauseAssessments,
      fixtureTreatmentActions,
      fixtureClosures,
    );
    const updateBlock = blocks.find((b) => b.title === 'עדכון טיפול');
    const text = updateBlock?.details.join('\n') ?? '';
    expect(text).toContain('פעולות טיפול: החלפת ציוד');
    // The free-text field is still there, once, unmodified.
    expect(text).toContain('פעולות שבוצעו: בוצעה בדיקת חומרה');
    // The structured line is compact -- it does not repeat the full
    // free-text sentence.
    const structuredLine = text.split('\n').find((l) => l.startsWith('פעולות טיפול:'));
    expect(structuredLine).not.toContain('בוצעה בדיקת חומרה');
  });

  it('renders the confirmed cause, treatment outcome, and resolution attribution (with its one linked action) on the CLOSED block belonging to that exact closure', () => {
    const blocks = buildTimelineBlocks(
      fixtureEvents,
      [fixtureUpdate],
      fixtureProfiles,
      fixtureCauseAssessments,
      fixtureTreatmentActions,
      fixtureClosures,
    );
    const closed = blocks.find((b) => b.title === 'התקלה נסגרה');
    const text = closed?.details.join('\n') ?? '';
    expect(text).toContain('הגורם שאומת: ציוד או חומרה');
    expect(text).toContain('תוצאת הטיפול: פתרון קבוע');
    expect(text).toContain('מה ידוע על מה שהוביל לפתרון: פעולה מסוימת שתועדה: החלפת ציוד');
  });

  it('a legacy closure (no matching closure row for the event refId) renders no classification lines at all -- just the existing readiness line', () => {
    const blocks = buildTimelineBlocks(fixtureEvents, [fixtureUpdate], fixtureProfiles, [], [], []);
    const closed = blocks.find((b) => b.title === 'התקלה נסגרה');
    const text = closed?.details.join('\n') ?? '';
    expect(text).toContain('כשירות בסגירה: מלאה');
    expect(text).not.toContain('הגורם שאומת');
    expect(text).not.toContain('תוצאת הטיפול');
    expect(text).not.toContain('מה ידוע על מה שהוביל לפתרון');
  });

  it('a legacy incident with no causeAssessments/treatmentActions at all renders the created/update blocks exactly as before this feature', () => {
    const blocks = buildTimelineBlocks(fixtureEvents, [fixtureUpdate], fixtureProfiles);
    const created = blocks.find((b) => b.title === 'התקלה נפתחה');
    expect(created?.details.join('\n')).not.toContain('חשד ראשוני');
    expect(created?.details.join('\n')).not.toContain('פעולות שסווגו');
    const update = blocks.find((b) => b.title === 'עדכון טיפול');
    expect(update?.details.join('\n')).not.toContain('פעולות טיפול:');
  });

  it('cancellation never shows closure classification, even if a closure row happens to share the cancelled event\'s refId', () => {
    const cancelledEvent: IncidentEvent = {
      id: 'evt-cancel',
      incidentId: 'i',
      type: 'cancelled',
      actorId: null,
      actorLabel: null,
      eventTime: '2026-08-01T10:00:00.000Z',
      serverTime: '2026-08-01T10:00:00.000Z',
      field: null,
      oldValue: null,
      newValue: null,
      note: 'נפתחה בטעות',
      userNote: null,
      refId: 'closure-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      operationId: 'op-cancel',
    };
    const blocks = buildTimelineBlocks([cancelledEvent], [], [], [], [], fixtureClosures);
    const text = blocks[0].details.join('\n');
    expect(text).not.toContain('הגורם שאומת');
    expect(text).not.toContain('תוצאת הטיפול');
  });

  it('a reopened incident with two separate closure cycles retains each closure\'s own classification on its own closed event, never overwritten by the other', () => {
    const closedCycle0: IncidentEvent = {
      id: 'evt-c0', incidentId: 'i', type: 'closed', actorId: null, actorLabel: null,
      eventTime: '2026-08-01T09:00:00.000Z', serverTime: '2026-08-01T09:00:00.000Z',
      field: null, oldValue: null, newValue: 'full', note: null, userNote: null,
      refId: 'closure-cycle-0', createdAt: '2026-08-01T09:00:00.000Z', operationId: 'op-close-0',
    };
    const reopened: IncidentEvent = {
      id: 'evt-r', incidentId: 'i', type: 'reopened', actorId: null, actorLabel: null,
      eventTime: '2026-08-01T10:00:00.000Z', serverTime: '2026-08-01T10:00:00.000Z',
      field: null, oldValue: 'closed', newValue: 'reopened', note: 'חזרה', userNote: null,
      refId: null, createdAt: '2026-08-01T10:00:00.000Z', operationId: 'op-reopen',
    };
    const closedCycle1: IncidentEvent = {
      id: 'evt-c1', incidentId: 'i', type: 'closed', actorId: null, actorLabel: null,
      eventTime: '2026-08-01T11:00:00.000Z', serverTime: '2026-08-01T11:00:00.000Z',
      field: null, oldValue: null, newValue: 'full', note: null, userNote: null,
      refId: 'closure-cycle-1', createdAt: '2026-08-01T11:00:00.000Z', operationId: 'op-close-1',
    };
    const closureCycle0: IncidentClosureClassification = {
      id: 'closure-cycle-0', incidentId: 'i', cycleNumber: 0, operationId: 'op-close-0',
      confirmedCause: 'software', confirmedCauseOtherDetail: null,
      treatmentOutcome: 'temporary_workaround', treatmentOutcomeOtherDetail: null,
      resolutionAttribution: 'undetermined', resolutionAttributionOtherDetail: null,
      resolutionActionIds: [], recordedBy: 'u', eventTime: '2026-08-01T09:00:00.000Z',
      recordedAt: '2026-08-01T09:00:00.000Z', createdAt: '2026-08-01T09:00:00.000Z',
    };
    const closureCycle1: IncidentClosureClassification = {
      id: 'closure-cycle-1', incidentId: 'i', cycleNumber: 1, operationId: 'op-close-1',
      confirmedCause: 'external', confirmedCauseOtherDetail: null,
      treatmentOutcome: 'permanent_resolution', treatmentOutcomeOtherDetail: null,
      resolutionAttribution: 'external_party_no_details', resolutionAttributionOtherDetail: null,
      resolutionActionIds: [], recordedBy: 'u', eventTime: '2026-08-01T11:00:00.000Z',
      recordedAt: '2026-08-01T11:00:00.000Z', createdAt: '2026-08-01T11:00:00.000Z',
    };
    const blocks = buildTimelineBlocks(
      [closedCycle0, reopened, closedCycle1],
      [],
      [],
      [],
      [],
      [closureCycle0, closureCycle1],
    );
    const closedBlocks = blocks.filter((b) => b.title === 'התקלה נסגרה');
    expect(closedBlocks).toHaveLength(2);
    const [first, second] = closedBlocks;
    expect(first.details.join('\n')).toContain('הגורם שאומת: תוכנה');
    expect(first.details.join('\n')).toContain('תוצאת הטיפול: פתרון זמני או מעקף');
    expect(first.details.join('\n')).toContain('מה ידוע על מה שהוביל לפתרון: לא ניתן לקבוע');
    expect(second.details.join('\n')).toContain('הגורם שאומת: גורם חיצוני');
    expect(second.details.join('\n')).toContain('תוצאת הטיפול: פתרון קבוע');
    expect(second.details.join('\n')).toContain('מה ידוע על מה שהוביל לפתרון: הטיפול בוצע על ידי גורם חיצוני ולא נמסרו פרטים');
  });
});

describe('exported classification value formatters (shared by the timeline and incidentPdf.ts\'s main summary)', () => {
  it('suspectedCauseValue: null ("never assessed") and the explicit \'unknown\' value ("assessed as not yet known") are never conflated', () => {
    expect(suspectedCauseValue(null)).toBe('לא הוזנה הערכת גורם');
    expect(suspectedCauseValue('unknown')).toBe('הגורם טרם ידוע');
    expect(suspectedCauseValue(null)).not.toBe(suspectedCauseValue('unknown'));
  });

  it('suspectedCauseValue: \'other\' includes the recorded detail', () => {
    // The detail is isolate()-wrapped (invisible RLI/PDI marks) so its own
    // bidi run never depends on the surrounding label -- toContain ignores
    // those marks the same way a human reader would.
    const value = suspectedCauseValue('other', 'תקלה בציוד נדיר שלא סווג');
    expect(value).toContain('אחר — ');
    expect(value).toContain('תקלה בציוד נדיר שלא סווג');
  });

  it('suspectedCauseValue: a populated non-other value never shows a detail suffix', () => {
    expect(suspectedCauseValue('equipment', 'should be ignored')).toBe('ציוד או חומרה');
  });

  it('confirmedCauseValue / treatmentOutcomeValue: approved Hebrew labels, \'other\' includes its detail', () => {
    const base: IncidentClosureClassification = {
      id: 'c', incidentId: 'i', cycleNumber: 0, operationId: null,
      confirmedCause: 'other', confirmedCauseOtherDetail: 'ציוד לא מתועד',
      treatmentOutcome: 'other', treatmentOutcomeOtherDetail: 'נסגרה בהסכמת המשתמש',
      resolutionAttribution: 'undetermined', resolutionAttributionOtherDetail: null,
      resolutionActionIds: [], recordedBy: 'u', eventTime: '2026-01-01T00:00:00.000Z',
      recordedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(confirmedCauseValue(base)).toContain('ציוד לא מתועד');
    expect(confirmedCauseValue(base)).toContain('אחר — ');
    expect(treatmentOutcomeValue(base)).toContain('נסגרה בהסכמת המשתמש');
    expect(treatmentOutcomeValue(base)).toContain('אחר — ');
  });

  it('resolutionAttributionValue: specific_action shows exactly its one linked action', () => {
    const closure: IncidentClosureClassification = {
      id: 'c', incidentId: 'i', cycleNumber: 0, operationId: null,
      confirmedCause: 'equipment', confirmedCauseOtherDetail: null,
      treatmentOutcome: 'permanent_resolution', treatmentOutcomeOtherDetail: null,
      resolutionAttribution: 'specific_action', resolutionAttributionOtherDetail: null,
      resolutionActionIds: [fixtureUpdateTreatmentAction.id], recordedBy: 'u',
      eventTime: '2026-01-01T00:00:00.000Z', recordedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(resolutionAttributionValue(closure, [fixtureUpdateTreatmentAction])).toBe('פעולה מסוימת שתועדה: החלפת ציוד');
  });

  it('resolutionAttributionValue: combination_of_actions shows all its linked, distinct actions comma-joined', () => {
    const closure: IncidentClosureClassification = {
      id: 'c', incidentId: 'i', cycleNumber: 0, operationId: null,
      confirmedCause: 'equipment', confirmedCauseOtherDetail: null,
      treatmentOutcome: 'permanent_resolution', treatmentOutcomeOtherDetail: null,
      resolutionAttribution: 'combination_of_actions', resolutionAttributionOtherDetail: null,
      resolutionActionIds: [fixtureInitialTreatmentAction.id, fixtureUpdateTreatmentAction.id], recordedBy: 'u',
      eventTime: '2026-01-01T00:00:00.000Z', recordedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(resolutionAttributionValue(closure, [fixtureInitialTreatmentAction, fixtureUpdateTreatmentAction])).toBe(
      'שילוב של מספר פעולות: בדיקה או אבחון, החלפת ציוד',
    );
  });

  it('resolutionAttributionValue: undetermined / no_action_taken / external_party_no_details render their plain approved labels, with no action list at all', () => {
    const make = (resolutionAttribution: IncidentClosureClassification['resolutionAttribution']): IncidentClosureClassification => ({
      id: 'c', incidentId: 'i', cycleNumber: 0, operationId: null,
      confirmedCause: 'equipment', confirmedCauseOtherDetail: null,
      treatmentOutcome: 'not_reproduced', treatmentOutcomeOtherDetail: null,
      resolutionAttribution, resolutionAttributionOtherDetail: null,
      resolutionActionIds: [], recordedBy: 'u', eventTime: '2026-01-01T00:00:00.000Z',
      recordedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(resolutionAttributionValue(make('undetermined'), [])).toBe('לא ניתן לקבוע');
    expect(resolutionAttributionValue(make('no_action_taken'), [])).toBe('לא בוצעה פעולה');
    expect(resolutionAttributionValue(make('external_party_no_details'), [])).toBe(
      'הטיפול בוצע על ידי גורם חיצוני ולא נמסרו פרטים',
    );
  });

  it('treatmentActionListValue joins multiple action labels with a comma, \'other\' included with its detail', () => {
    const actions: IncidentTreatmentAction[] = [
      fixtureInitialTreatmentAction,
      { ...fixtureUpdateTreatmentAction, id: 'a3', actionType: 'other', otherDetail: 'פעולה חריגה' },
    ];
    const value = treatmentActionListValue(actions);
    expect(value).toContain('בדיקה או אבחון, אחר — ');
    expect(value).toContain('פעולה חריגה');
  });
});
