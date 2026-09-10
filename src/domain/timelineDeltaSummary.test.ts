import { describe, expect, it } from 'vitest';
import { LONG_DELTA_VALUE_THRESHOLD, isLongDeltaValue, isLongFieldDelta } from './timelineDeltaSummary';

describe('isLongDeltaValue', () => {
  it('is false for a value at or under the threshold', () => {
    expect(isLongDeltaValue('א'.repeat(LONG_DELTA_VALUE_THRESHOLD))).toBe(false);
  });

  it('is true for a value over the threshold', () => {
    expect(isLongDeltaValue('א'.repeat(LONG_DELTA_VALUE_THRESHOLD + 1))).toBe(true);
  });

  it('treats real short enum-style labels as short', () => {
    for (const label of ['חדשה', 'בטיפול', 'קריטית', 'בינונית', 'נפתרה, ממתינה לסגירה', 'ציוד או חומרה']) {
      expect(isLongDeltaValue(label)).toBe(false);
    }
  });

  it('treats a real composed free-text value (e.g. an external-handler snapshot) as long', () => {
    expect(isLongDeltaValue('אלתא שירותי תחזוקה בע"מ · איש קשר: עילאי שפירא · פרטי קשר: 052-1234567')).toBe(true);
  });
});

describe('isLongFieldDelta', () => {
  it('is false when both sides are short', () => {
    expect(isLongFieldDelta('חדשה', 'בטיפול')).toBe(false);
  });

  it('is true when only the "before" side is long', () => {
    const longBefore = 'א'.repeat(LONG_DELTA_VALUE_THRESHOLD + 5);
    expect(isLongFieldDelta(longBefore, 'קצר')).toBe(true);
  });

  it('is true when only the "after" side is long', () => {
    const longAfter = 'א'.repeat(LONG_DELTA_VALUE_THRESHOLD + 5);
    expect(isLongFieldDelta('קצר', longAfter)).toBe(true);
  });

  it('is false for a null "before" (single-value form) paired with a short "after"', () => {
    expect(isLongFieldDelta(null, 'קצר')).toBe(false);
  });

  it('is true for a null "before" paired with a long "after"', () => {
    const longAfter = 'א'.repeat(LONG_DELTA_VALUE_THRESHOLD + 5);
    expect(isLongFieldDelta(null, longAfter)).toBe(true);
  });
});
