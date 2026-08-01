import { describe, expect, it } from 'vitest';
import { isolate, mirroredForRtl, resolveBidiRuns } from './bidi';

describe('isolate', () => {
  it('wraps a value containing a strong (Hebrew or Latin) letter in RLI/PDI, matching the surrounding RTL document', () => {
    expect(isolate('NET2000')).toBe('⁧NET2000⁩');
    expect(isolate('Martin Gusin')).toBe('⁧Martin Gusin⁩');
    expect(isolate('רועי כהן')).toBe('⁧רועי כהן⁩');
  });

  it('wraps a value with no strong letter (a formatted date/time, an incident number) in LRI/PDI instead -- otherwise its own internal punctuation (e.g. the comma in a date) resolves in the wrong order under an RTL base, confirmed empirically against poppler', () => {
    expect(isolate('01.08.2026, 09:15')).toBe('⁦01.08.2026, 09:15⁩');
    expect(isolate('2026-014')).toBe('⁦2026-014⁩');
  });
});

describe('resolveBidiRuns', () => {
  it('returns no runs for empty input', () => {
    expect(resolveBidiRuns('')).toEqual([]);
  });

  it('keeps a pure-Hebrew string in one RTL run, in ordinary logical (never reversed) order', () => {
    const runs = resolveBidiRuns('מספר תקלה');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ text: 'מספר תקלה', rtl: true });
  });

  it('keeps a pure-Latin/digit string in one LTR run, in its original order', () => {
    const runs = resolveBidiRuns('NET2000', 'ltr');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ text: 'NET2000', rtl: false });
  });

  it('splits a label + isolated identifier into an RTL run and an LTR run, each holding its own literal (unreversed) substring', () => {
    const runs = resolveBidiRuns(`מספר תקלה: ${isolate('2026-014')}`);
    // Every run's text is a literal, forward-order substring of the
    // logical string -- concatenating the runs' texts in order must
    // reconstruct exactly the original content (isolate marks aside).
    expect(runs.map((r) => r.text).join('')).toBe('מספר תקלה: 2026-014');
    const numberRun = runs.find((r) => r.text.includes('2026-014'));
    expect(numberRun).toEqual({ text: '2026-014', rtl: false });
    expect(runs.some((r) => r.rtl && r.text.includes('מספר'))).toBe(true);
  });

  it('keeps a technical identifier such as NET2000 as one unreversed LTR run inside Hebrew text', () => {
    const runs = resolveBidiRuns(`מערכת / עמדה: ${isolate('NET2000')}`);
    expect(runs.some((r) => r.text === 'NET2000' && !r.rtl)).toBe(true);
    // Digits must never come out reversed (e.g. "0002TEN" or similar).
    expect(runs.map((r) => r.text).join('')).toContain('NET2000');
  });

  it('never reverses an isolated Hebrew value either -- an isolated Hebrew value shares its run\'s RTL direction with the surrounding Hebrew label, and stays in forward order', () => {
    const runs = resolveBidiRuns(`שם: ${isolate('רועי כהן')}`);
    // Same-direction neighbors merge into one run (isolate() only ever
    // marks where a *different*-direction run must start) -- the whole
    // line reconstructs exactly, forward, never reversed.
    expect(runs).toEqual([{ text: 'שם: רועי כהן', rtl: true }]);
  });

  it('reconstructs the exact original text (isolate marks aside) for representative mixed content, proving nothing is ever character-reversed', () => {
    const cases = [
      `דוח תקלה ${isolate('2026-014')}`,
      `סטטוס שונה: ${isolate('חדשה')} ← ${isolate('בטיפול')}`,
      `הופק על ידי ${isolate('Martin Gusin')} · ${isolate('01.08.2026, 20:03')}`,
      'בדיקה (הערה) נוספת',
    ];
    for (const text of cases) {
      const runs = resolveBidiRuns(text);
      const logical = text.replace(/[⁦-⁩]/g, '');
      expect(runs.map((r) => r.text).join('')).toBe(logical);
    }
  });
});

describe('mirroredForRtl', () => {
  it('mirrors an opening paren to a closing shape and vice versa', () => {
    expect(mirroredForRtl('(')).toBe(')');
    expect(mirroredForRtl(')')).toBe('(');
  });

  it('leaves a character with no mirror pair unchanged', () => {
    expect(mirroredForRtl('א')).toBe('א');
    expect(mirroredForRtl('A')).toBe('A');
  });
});
