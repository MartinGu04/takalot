import { describe, expect, it } from 'vitest';
import { timelineVisualKind, isRichTimelineEvent } from './timelineEventKind';
import type { EventType } from './types';

describe('timelineVisualKind', () => {
  it('maps each of the six named semantic types to its own color kind', () => {
    expect(timelineVisualKind('created')).toBe('open');
    expect(timelineVisualKind('update')).toBe('update');
    expect(timelineVisualKind('status_change')).toBe('status');
    expect(timelineVisualKind('closed')).toBe('closed');
    expect(timelineVisualKind('reopened')).toBe('reopened');
  });

  it('maps every reporting-to-operations event type to the same "report" color, regardless of which one', () => {
    const reportingTypes: EventType[] = ['reported_to_ops_change', 'reported_to_ops_room', 'reported_to_ops_communications'];
    for (const type of reportingTypes) {
      expect(timelineVisualKind(type)).toBe('report');
    }
  });

  it('gives cancelled its own kind, distinct from the generic neutral bucket', () => {
    expect(timelineVisualKind('cancelled')).toBe('cancelled');
    expect(timelineVisualKind('cancelled')).not.toBe(timelineVisualKind('severity_change'));
  });

  it('falls back to "neutral" for every minor audit delta type with no dedicated color', () => {
    const minorTypes: EventType[] = [
      'severity_change',
      'impact_change',
      'assignment_change',
      'deadline_change',
      'acknowledged',
      'follow_up_completed',
      'correction',
      'cause_assessment_changed',
      'severity_assessed',
      'status_check_changed',
      'handover_included',
      'handover_accepted',
    ];
    for (const type of minorTypes) {
      expect(timelineVisualKind(type)).toBe('neutral');
    }
  });
});

describe('isRichTimelineEvent', () => {
  it('treats the incident lifecycle, treatment updates, and corrections as rich (card) events', () => {
    const richTypes: EventType[] = ['created', 'closed', 'reopened', 'cancelled', 'update', 'correction'];
    for (const type of richTypes) {
      expect(isRichTimelineEvent(type)).toBe(true);
    }
  });

  it('treats every single-field delta type as compact, not rich', () => {
    const compactTypes: EventType[] = [
      'status_change',
      'severity_change',
      'impact_change',
      'assignment_change',
      'deadline_change',
      'reported_to_ops_change',
      'reported_to_ops_room',
      'reported_to_ops_communications',
      'cause_assessment_changed',
      'severity_assessed',
      'status_check_changed',
      'acknowledged',
      'follow_up_completed',
      'handover_included',
      'handover_accepted',
    ];
    for (const type of compactTypes) {
      expect(isRichTimelineEvent(type)).toBe(false);
    }
  });
});
