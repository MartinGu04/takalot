// Related-incident similarity: mirrors supabase/migrations/0050's
// suggest_related_incidents RPC. Table-driven against the 5 worked examples
// from the approved product plan, plus the correctness fixes from the
// implementation-approval round (negation exclusion, cross-system-at-high-
// band-only, deterministic ranking).
import { describe, expect, it } from 'vitest';
import {
  formatSuggestionReason,
  hasNegation,
  selectSimilarIncidentSuggestions,
  stripNoiseWords,
  trigramSimilarity,
  type SimilarityCandidate,
  type SimilarityQuery,
} from './similarity';

function candidate(overrides: Partial<SimilarityCandidate> & { incidentId: string }): SimilarityCandidate {
  return {
    number: '2026-000',
    severity: 'medium',
    status: 'in_progress',
    systemId: 'sys-alpha',
    locationId: 'loc-1',
    description: '',
    reportedDomain: null,
    ...overrides,
  };
}

const baseQuery: SimilarityQuery = {
  systemId: 'sys-alpha',
  locationId: 'loc-1',
  reportedDomain: 'equipment',
  description: 'מערכת אלפא אינה מגיבה לפקודות הפעלה, מתקבלת שגיאת timeout בחיבור לשרת',
};

describe('stripNoiseWords', () => {
  it('removes generic operational boilerplate (as whole words) but never negation words', () => {
    expect(stripNoiseWords('תקלה בעיה מערכת עובד בדיקה בוצע כרגע')).not.toMatch(/תקלה|בעיה|מערכת|עובד|בדיקה|בוצע|כרגע/);
    expect(stripNoiseWords('המערכת לא עובדת')).toContain('לא');
    expect(stripNoiseWords('אין תקשורת בין העמדות')).toContain('אין');
  });

  it('does not strip a noise word glued to a Hebrew prefix (ב/ל/כ/מ/ו/ש/ה) -- a known, accepted limitation shared with the SQL side\'s identical \\y word-boundary behavior', () => {
    // "במערכת" (glued ב+מערכת) is not a whole-word match for "מערכת" --
    // exactly like Postgres's \y boundary wouldn't match it either. This
    // documents the limitation rather than hiding it.
    expect(stripNoiseWords('נמצאה תקלה במערכת')).toContain('במערכת');
  });
});

describe('hasNegation', () => {
  it('detects bare negation particles and the "is not" copula forms', () => {
    expect(hasNegation('המערכת לא עובדת')).toBe(true);
    expect(hasNegation('אין תקשורת')).toBe(true);
    expect(hasNegation('מערכת אלפא אינה מגיבה')).toBe(true);
    expect(hasNegation('התקנה בוצעה בלי בעיות')).toBe(true);
    expect(hasNegation('המערכת עובדת כרגיל')).toBe(false);
  });
});

describe('trigramSimilarity', () => {
  it('is 1 for identical strings and near 0 for wholly unrelated ones', () => {
    expect(trigramSimilarity('שלום עולם', 'שלום עולם')).toBe(1);
    expect(trigramSimilarity('אבגדהוזחט', 'קרסתץףץ')).toBeLessThan(0.1);
  });

  it('treats a nearly-identical negated pair as highly similar at the raw level', () => {
    // This is exactly the empirically-verified property that makes a
    // standalone numeric penalty unreliable and justifies the hard
    // negation-mismatch exclusion in selectSimilarIncidentSuggestions
    // below, rather than trying to subtract a fixed amount here.
    const a = 'התקשורת בין מערכת בטא לעמדת הבקרה עובדת בצורה תקינה ויציבה לחלוטין';
    const b = 'התקשורת בין מערכת בטא לעמדת הבקרה לא עובדת בצורה תקינה ויציבה לחלוטין';
    expect(trigramSimilarity(a, b)).toBeGreaterThan(0.8);
  });
});

describe('selectSimilarIncidentSuggestions: the 5 required worked examples', () => {
  it('1. same system + same location + highly similar description -> suggested, high band, both facets in reason', () => {
    const c = candidate({
      incidentId: 'i1',
      systemId: 'sys-alpha',
      locationId: 'loc-1',
      description: 'מערכת אלפא אינה מגיבה לפקודות הפעלה, מתקבלת שגיאת timeout מול השרת',
    });
    const [result] = selectSimilarIncidentSuggestions(baseQuery, [c]);
    expect(result).toBeDefined();
    expect(result.similarityBand).toBe('high');
    expect(result.sameSystem).toBe(true);
    expect(result.sameLocation).toBe(true);
    expect(formatSuggestionReason(result)).toBe('אותה מערכת · אותו מיקום · תיאור דומה מאוד');
  });

  it('2. same system + different location + highly similar description -> still suggested, location absent from reason', () => {
    const c = candidate({
      incidentId: 'i2',
      systemId: 'sys-alpha',
      locationId: 'loc-9-different',
      description: 'מערכת אלפא אינה מגיבה לפקודות הפעלה, מתקבלת שגיאת timeout מול השרת',
    });
    const [result] = selectSimilarIncidentSuggestions(baseQuery, [c]);
    expect(result).toBeDefined();
    expect(result.sameLocation).toBe(false);
    expect(formatSuggestionReason(result)).not.toContain('אותו מיקום');
  });

  it('3. same system + same location + completely different description -> REJECTED (proves structural signals alone never suggest)', () => {
    const c = candidate({
      incidentId: 'i3',
      systemId: 'sys-alpha',
      locationId: 'loc-1',
      description: 'המסך של עמדת הקופה נותק ואין תמונה כלל על הצג הראשי',
    });
    const results = selectSimilarIncidentSuggestions(baseQuery, [c]);
    expect(results).toEqual([]);
  });

  it('4. same system + different reported domain + similar description -> suggested, domain absent from reason (mismatch never disqualifies)', () => {
    const c = candidate({
      incidentId: 'i4',
      systemId: 'sys-alpha',
      locationId: 'loc-1',
      reportedDomain: 'software',
      description: 'מערכת אלפא אינה מגיבה לפקודות הפעלה, מתקבלת שגיאת timeout מול השרת',
    });
    const [result] = selectSimilarIncidentSuggestions(baseQuery, [c]);
    expect(result).toBeDefined();
    expect(result.sameDomain).toBe(false);
    expect(formatSuggestionReason(result)).not.toContain('אותו תחום תקלה');
  });

  it('5. different system + nearly identical GENERIC wording -> REJECTED (stoplist neutralizes boilerplate overlap)', () => {
    const genericQuery: SimilarityQuery = {
      systemId: 'sys-alpha',
      locationId: 'loc-1',
      reportedDomain: null,
      description: 'יש תקלה, בעיה במערכת, בוצעה בדיקה',
    };
    const c = candidate({
      incidentId: 'i5',
      systemId: 'sys-beta',
      locationId: 'loc-2',
      description: 'קיימת תקלה, יש בעיה במערכת אחרת, גם כאן בוצעה בדיקה',
    });
    const results = selectSimilarIncidentSuggestions(genericQuery, [c]);
    expect(results).toEqual([]);
  });
});

describe('selectSimilarIncidentSuggestions: cross-system eligibility', () => {
  it('a different system with only MEDIUM description similarity is rejected (system required at medium band)', () => {
    const c = candidate({
      incidentId: 'i6',
      systemId: 'sys-beta',
      description: 'מערכת אלפא אינה מגיבה, שגיאה מסוימת מופיעה על המסך לעיתים',
    });
    // Force a medium-band case by using a query that overlaps moderately.
    const mediumQuery: SimilarityQuery = { ...baseQuery, description: 'מערכת אלפא אינה מגיבה כרגע' };
    const results = selectSimilarIncidentSuggestions(mediumQuery, [c]);
    expect(results.every((r) => r.incidentId !== 'i6')).toBe(true);
  });

  it('a different system CAN be suggested when description similarity is HIGH', () => {
    const c = candidate({
      incidentId: 'i7',
      systemId: 'sys-beta',
      description: baseQuery.description, // identical text, different system -> high band
    });
    const results = selectSimilarIncidentSuggestions(baseQuery, [c]);
    expect(results.some((r) => r.incidentId === 'i7' && r.similarityBand === 'high')).toBe(true);
  });
});

describe('selectSimilarIncidentSuggestions: negation exclusion', () => {
  it('excludes a near-identical description that flips negation relative to the query', () => {
    const query: SimilarityQuery = {
      systemId: 'sys-alpha',
      locationId: 'loc-1',
      reportedDomain: null,
      description: 'התקשורת בין מערכת בטא לעמדת הבקרה עובדת בצורה תקינה ויציבה לחלוטין',
    };
    const c = candidate({
      incidentId: 'i8',
      systemId: 'sys-alpha',
      description: 'התקשורת בין מערכת בטא לעמדת הבקרה לא עובדת בצורה תקינה ויציבה לחלוטין',
    });
    expect(selectSimilarIncidentSuggestions(query, [c])).toEqual([]);
  });

  it('does not exclude when negation state matches on both sides (both affirmative or both negated)', () => {
    const query: SimilarityQuery = {
      systemId: 'sys-alpha',
      locationId: 'loc-1',
      reportedDomain: null,
      description: 'מערכת אלפא אינה מגיבה לפקודות הפעלה',
    };
    const c = candidate({
      incidentId: 'i9',
      systemId: 'sys-alpha',
      description: 'מערכת אלפא לא מגיבה לפקודות הפעלה',
    });
    const results = selectSimilarIncidentSuggestions(query, [c]);
    expect(results.some((r) => r.incidentId === 'i9')).toBe(true);
  });
});

describe('selectSimilarIncidentSuggestions: candidate limit and ranking', () => {
  it('never returns more than 3 suggestions even when more qualify', () => {
    const candidates = Array.from({ length: 6 }, (_, n) =>
      candidate({ incidentId: `many-${n}`, systemId: 'sys-alpha', locationId: 'loc-1', description: baseQuery.description }),
    );
    const results = selectSimilarIncidentSuggestions(baseQuery, candidates);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('ranks a candidate with more corroborating structural signals above an equally-similar one with fewer, among qualifying candidates', () => {
    const strong = candidate({
      incidentId: 'strong',
      systemId: 'sys-alpha',
      locationId: 'loc-1', // same location as query
      reportedDomain: 'equipment', // same domain as query
      description: baseQuery.description,
    });
    const weak = candidate({
      incidentId: 'weak',
      systemId: 'sys-alpha',
      locationId: 'loc-9-different',
      reportedDomain: 'software', // different domain -> penalty
      description: baseQuery.description,
    });
    const results = selectSimilarIncidentSuggestions(baseQuery, [weak, strong]);
    expect(results[0]?.incidentId).toBe('strong');
  });

  it('never uses severity as a matching or ranking signal', () => {
    const critical = candidate({
      incidentId: 'sev-critical',
      severity: 'critical',
      systemId: 'sys-alpha',
      locationId: 'loc-1',
      description: baseQuery.description,
    });
    const low = candidate({
      incidentId: 'sev-low',
      severity: 'low',
      systemId: 'sys-alpha',
      locationId: 'loc-1',
      description: baseQuery.description,
    });
    const results = selectSimilarIncidentSuggestions(baseQuery, [low, critical]);
    // Identical in every scored dimension except severity -- order between
    // them is whatever a stable sort gives, but BOTH must qualify (severity
    // never gates) and the reason text must never mention severity.
    expect(results.map((r) => r.incidentId).sort()).toEqual(['sev-critical', 'sev-low']);
    for (const r of results) expect(formatSuggestionReason(r)).not.toMatch(/חומרה|קריטית|נמוכה/);
  });
});

describe('selectSimilarIncidentSuggestions: legacy/edge inputs', () => {
  it('no candidates -> no suggestions, no throw', () => {
    expect(selectSimilarIncidentSuggestions(baseQuery, [])).toEqual([]);
  });

  it('a candidate with reportedDomain null never counts as a domain match, even when the query domain is also null', () => {
    const query: SimilarityQuery = { ...baseQuery, reportedDomain: null };
    const c = candidate({ incidentId: 'nulldomain', systemId: 'sys-alpha', locationId: 'loc-1', description: baseQuery.description, reportedDomain: null });
    const [result] = selectSimilarIncidentSuggestions(query, [c]);
    expect(result.sameDomain).toBe(false);
  });

  it('a query with no locationId never marks any candidate as sameLocation', () => {
    const query: SimilarityQuery = { ...baseQuery, locationId: null };
    const c = candidate({ incidentId: 'noloc', systemId: 'sys-alpha', locationId: 'loc-1', description: baseQuery.description });
    const [result] = selectSimilarIncidentSuggestions(query, [c]);
    expect(result.sameLocation).toBe(false);
  });
});
