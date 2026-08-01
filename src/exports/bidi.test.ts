import { describe, expect, it } from 'vitest';
import { isolate, resolveBidiVisual } from './bidi';

describe('isolate', () => {
  it('wraps a value in explicit FSI/PDI isolate marks', () => {
    expect(isolate('NET2000')).toBe('⁨NET2000⁩');
  });
});

describe('resolveBidiVisual', () => {
  it('returns an empty string for empty input', () => {
    expect(resolveBidiVisual('')).toBe('');
  });

  it('reverses a pure-Hebrew RTL string into left-to-right glyph order', () => {
    // For a single-embedding-level (pure RTL, no embedded LTR runs) string,
    // the correct visual-glyph-order transform is exactly the character
    // array reversed -- this is the mathematically simplest case and lets
    // us assert correctness without relying on being able to read Hebrew.
    const text = 'מספר תקלה';
    const expected = text.split('').reverse().join('');
    expect(resolveBidiVisual(text)).toBe(expected);
  });

  it('keeps an isolated LTR run in its own internal left-to-right order', () => {
    const resolved = resolveBidiVisual(`מספר תקלה: ${isolate('2026-014')}`);
    // The isolated value's own characters must stay contiguous and in
    // their original order -- only its position within the line moves.
    expect(resolved).toContain('2026-014');
  });

  it('keeps a technical identifier such as NET2000 in its own left-to-right order', () => {
    const resolved = resolveBidiVisual(`מערכת / עמדה: ${isolate('NET2000')}`);
    expect(resolved).toContain('NET2000');
  });

  it('places an isolated LTR value to the left of its Hebrew label (label ends the visual string)', () => {
    // Visual order is meant for jsPDF align:'right': array index 0 draws
    // leftmost, the last index draws at the right margin. The Hebrew label
    // (read first, rightmost) must therefore end the resolved string.
    const resolved = resolveBidiVisual(`מספר תקלה: ${isolate('2026-014')}`);
    expect(resolved.endsWith('הלקת רפסמ')).toBe(true);
    expect(resolved.startsWith('2026-014')).toBe(true);
  });

  it('strips isolate marks from the resolved output', () => {
    const resolved = resolveBidiVisual(`תקלה: ${isolate('X')}`);
    expect(resolved).not.toMatch(/[⁦-⁩]/);
  });

  it('mirrors parentheses so they still visually open/close around Hebrew content', () => {
    const resolved = resolveBidiVisual('בדיקה (הערה) נוספת');
    // In a reversed RTL run, '(' and ')' must swap so the pair keeps
    // reading as an opening/closing bracket rather than becoming inverted.
    const openIndex = resolved.indexOf('(');
    const closeIndex = resolved.indexOf(')');
    expect(openIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeGreaterThan(-1);
    expect(openIndex).toBeLessThan(closeIndex);
  });

  it('does not reorder a plain LTR-only string under an rtl base direction call site', () => {
    // A base-direction-agnostic sanity check: pure Latin/digit content run
    // through the ltr path is untouched.
    expect(resolveBidiVisual('NET2000', 'ltr')).toBe('NET2000');
  });
});
