import { describe, expect, it } from 'vitest';
import { buildIncidentOpenedMessage, buildIncidentClosedMessage } from './notificationMessage';
import type { Severity } from './types';

describe('buildIncidentOpenedMessage', () => {
  it('matches the exact required format and emoji/wording for every severity', () => {
    const cases: Array<{ severity: Severity; expected: string }> = [
      { severity: 'critical', expected: '🔴 נפתחה תקלה קריטית 2026-041 במערכת AVARIA על ידי מרטין גוסין' },
      { severity: 'high', expected: '🟠 נפתחה תקלה בחומרה גבוהה 2026-041 במערכת AVARIA על ידי מרטין גוסין' },
      { severity: 'medium', expected: '🟡 נפתחה תקלה בחומרה בינונית 2026-041 במערכת AVARIA על ידי מרטין גוסין' },
      { severity: 'low', expected: '🟢 נפתחה תקלה בחומרה נמוכה 2026-041 במערכת AVARIA על ידי מרטין גוסין' },
    ];
    for (const { severity, expected } of cases) {
      expect(
        buildIncidentOpenedMessage({ number: '2026-041', severity }, 'AVARIA', 'מרטין גוסין'),
      ).toBe(expected);
    }
  });

  it('matches the second worked example exactly (high severity, a different system)', () => {
    expect(
      buildIncidentOpenedMessage({ number: '2026-042', severity: 'high' }, 'תקשורת', 'מרטין גוסין'),
    ).toBe('🟠 נפתחה תקלה בחומרה גבוהה 2026-042 במערכת תקשורת על ידי מרטין גוסין');
  });

  it('uses exactly the incident number, system name, and actor name passed in -- never anything else', () => {
    const message = buildIncidentOpenedMessage(
      { number: '2026-099', severity: 'low' },
      'מערכת בדיקה',
      'שם שחקן',
    );
    expect(message).toContain('2026-099');
    expect(message).toContain('מערכת בדיקה');
    expect(message).toContain('שם שחקן');
  });
});

describe('buildIncidentClosedMessage', () => {
  it('matches the exact required format and worked example', () => {
    const message = buildIncidentClosedMessage(
      {
        number: '2026-041',
        discoveredAt: '2026-01-01T10:00:00.000Z',
        closedAt: '2026-01-01T13:24:00.000Z',
        createdAt: '2026-01-01T10:05:00.000Z',
      },
      'AVARIA',
      'מרטין גוסין',
    );
    expect(message).toBe('✅ תקלה 2026-041 במערכת AVARIA נסגרה על ידי מרטין גוסין לאחר 3 שעות ו־24 דקות');
  });

  it('computes the duration from the persisted discoveredAt/closedAt pair, independent of any current wall-clock time', () => {
    // discoveredAt/closedAt are both far in the past relative to whenever
    // this test actually runs -- if the duration were ever computed against
    // "now" instead of the persisted closedAt, this would report a duration
    // of years, not the fixed 90-minute gap between the two timestamps.
    const message = buildIncidentClosedMessage(
      {
        number: '2020-001',
        discoveredAt: '2020-01-01T08:00:00.000Z',
        closedAt: '2020-01-01T09:30:00.000Z',
        createdAt: '2020-01-01T08:05:00.000Z',
      },
      'מערכת ישנה',
      'בודק',
    );
    expect(message).toContain('לאחר שעה אחת ו־30 דקות');
  });

  it('falls back to createdAt only when closedAt is null (defensive -- callers only invoke this after an actual close)', () => {
    const message = buildIncidentClosedMessage(
      {
        number: '2026-050',
        discoveredAt: '2026-01-01T10:00:00.000Z',
        closedAt: null,
        createdAt: '2026-01-01T11:00:00.000Z',
      },
      'AVARIA',
      'בודק',
    );
    expect(message).toContain('לאחר שעה אחת');
  });
});
