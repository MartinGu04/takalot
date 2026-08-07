// Related-incident similarity: description-similarity gate + system/
// location/domain corroboration, mirroring supabase/migrations/0050's
// suggest_related_incidents RPC (server-side, Supabase mode) so the local
// demo backend produces the same qualitative behavior. The two
// implementations cannot literally share code across languages -- this
// file exists specifically so both can be exercised against the SAME
// table-driven test examples (similarity.test.ts), catching any drift
// between them.
//
// Core principle (unchanged from the approved product design): description
// similarity is a MANDATORY gate, never optional. System/location/domain
// only ever corroborate or rank among candidates that already passed it --
// "same system" alone can never produce a suggestion.
import type { Incident, IncidentDomain, IncidentStatus, Severity, SimilarIncidentSuggestion } from './types';

/** Generic operational boilerplate that carries no discriminative content
 *  about what an incident actually IS -- see migration 0049's header for
 *  the full per-term justification. Deliberately small and literal, never
 *  a lookup table. Negation words (לא/אין/אינו/אינה/אינם/אינן/בלי) are
 *  PERMANENTLY excluded -- stripping them would let opposite-meaning
 *  descriptions collapse toward the same normalized text. */
const NOISE_WORDS = ['תקלה', 'בעיה', 'מערכת', 'עובד', 'עובדת', 'בדיקה', 'נבדק', 'בוצע', 'בוצעה', 'כרגע'];

/** Standard Hebrew negation particles AND the "is not" copula forms
 *  (אינו/אינה/אינם/אינן) -- a regex covering only לא/אין/בלי under-detects
 *  real report Hebrew (verified empirically: this app's own seed incident
 *  text uses אינה, not לא). */
const NEGATION_WORDS = ['לא', 'אין', 'אינו', 'אינה', 'אינם', 'אינן', 'בלי'];

const NIQQUD_RE = /[֑-ׇ]/g;

// JS regex \b is defined in terms of \w ([A-Za-z0-9_]), which does NOT
// include Hebrew letters -- so \b never fires as a real word boundary
// anywhere in an all-Hebrew string. Lookaround against the Hebrew letter
// range is what actually emulates "whole word" matching here.
function wholeWordPattern(words: string[]): RegExp {
  return new RegExp(`(?<![א-ת])(${words.join('|')})(?![א-ת])`, 'g');
}

const NOISE_PATTERN = wholeWordPattern(NOISE_WORDS);
const NEGATION_PATTERN = wholeWordPattern(NEGATION_WORDS);

/** Same normalized representation used for BOTH candidate retrieval and
 *  final scoring (mirrors the SQL side's single strip_noise_words()
 *  expression index) -- never two different representations that could
 *  silently disagree about what "the description" means. */
export function stripNoiseWords(text: string | null | undefined): string {
  const withoutNiqqud = (text ?? '').replace(NIQQUD_RE, '');
  NOISE_PATTERN.lastIndex = 0;
  return withoutNiqqud.replace(NOISE_PATTERN, '').trim().replace(/\s+/g, ' ');
}

export function hasNegation(text: string | null | undefined): boolean {
  NEGATION_PATTERN.lastIndex = 0;
  return NEGATION_PATTERN.test(text ?? '');
}

/** pg_trgm-style trigram extraction: 2 leading + 1 trailing pad character,
 *  overlapping 3-character substrings. */
function trigrams(s: string): string[] {
  const padded = `  ${s} `;
  const grams: string[] = [];
  for (let i = 0; i <= padded.length - 3; i++) grams.push(padded.slice(i, i + 3));
  return grams;
}

/** Multiset Jaccard similarity over trigrams, 0..1 -- the same formula
 *  pg_trgm's similarity() uses (shared / (|A| + |B| - shared), counting
 *  multiplicities, not just distinct trigrams). Not a byte-for-byte
 *  reimplementation of the C extension, but the same algorithm family;
 *  the local demo backend documents elsewhere that it approximates
 *  documented server rules rather than being the source of truth. */
export function trigramSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const countsA = new Map<string, number>();
  for (const g of trigrams(a)) countsA.set(g, (countsA.get(g) ?? 0) + 1);
  const countsB = new Map<string, number>();
  for (const g of trigrams(b)) countsB.set(g, (countsB.get(g) ?? 0) + 1);
  let shared = 0;
  let totalA = 0;
  for (const [g, ca] of countsA) {
    totalA += ca;
    shared += Math.min(ca, countsB.get(g) ?? 0);
  }
  let totalB = 0;
  for (const cb of countsB.values()) totalB += cb;
  const union = totalA + totalB - shared;
  return union === 0 ? 0 : shared / union;
}

export const MIN_DESCRIPTION_SIMILARITY = 0.3;
export const HIGH_DESCRIPTION_SIMILARITY = 0.55;

export interface SimilarityCandidate {
  incidentId: string;
  number: string;
  severity: Severity;
  status: IncidentStatus;
  systemId: string;
  locationId: string;
  description: string;
  reportedDomain: IncidentDomain | null;
}

export interface SimilarityQuery {
  systemId: string;
  locationId: string | null;
  reportedDomain: IncidentDomain | null;
  description: string;
}

/**
 * Selects up to 3 candidates: description similarity (post-normalization,
 * negation-consistent) is a mandatory gate; system/location/domain only
 * refine ranking among candidates that already passed it. A different
 * system is only ever eligible at the HIGH similarity band. Mirrors
 * suggest_related_incidents (0050) exactly -- see its comments for the
 * reasoning behind each rule (hard negation exclusion over a numeric
 * penalty, cross-system-at-high-band-only, etc).
 *
 * `candidates` is assumed already scoped to open (non-closed/cancelled)
 * incidents -- callers (localRepository) apply that filter themselves,
 * exactly like the SQL RPC's own WHERE clause does server-side.
 */
export function selectSimilarIncidentSuggestions(
  query: SimilarityQuery,
  candidates: readonly SimilarityCandidate[],
): SimilarIncidentSuggestion[] {
  const normQuery = stripNoiseWords(query.description);
  const queryNegation = hasNegation(query.description);

  const ranked = candidates
    .map((c) => {
      const sim = trigramSimilarity(stripNoiseWords(c.description), normQuery);
      return { c, sim, negation: hasNegation(c.description) };
    })
    .filter(({ c, sim, negation }) => {
      if (sim < MIN_DESCRIPTION_SIMILARITY) return false;
      if (negation !== queryNegation) return false;
      if (c.systemId !== query.systemId && sim < HIGH_DESCRIPTION_SIMILARITY) return false;
      return true;
    })
    .map(({ c, sim }) => {
      const sameSystem = c.systemId === query.systemId;
      const sameLocation = query.locationId != null && c.locationId === query.locationId;
      const sameDomain =
        c.reportedDomain != null && query.reportedDomain != null && c.reportedDomain === query.reportedDomain;
      const domainScore =
        c.reportedDomain == null || query.reportedDomain == null ? 0 : sameDomain ? 5 : -3;
      const rankScore = sim * 100 + (sameLocation ? 10 : 0) + domainScore;
      const suggestion: SimilarIncidentSuggestion = {
        incidentId: c.incidentId,
        number: c.number,
        severity: c.severity,
        status: c.status,
        systemId: c.systemId,
        locationId: c.locationId,
        description: c.description,
        sameSystem,
        sameLocation,
        sameDomain,
        similarityBand: sim >= HIGH_DESCRIPTION_SIMILARITY ? 'high' : 'medium',
      };
      return { suggestion, rankScore };
    });

  ranked.sort((a, b) => b.rankScore - a.rankScore);
  return ranked.slice(0, 3).map((r) => r.suggestion);
}

/** Human-readable reason, e.g. "אותה מערכת · אותו מיקום · תיאור דומה" --
 *  never a raw numeric score (never shown to the user). Only ever lists
 *  POSITIVE matching facets; a non-matching system/location/domain is
 *  simply omitted, never stated as a caveat. */
export function formatSuggestionReason(s: SimilarIncidentSuggestion): string {
  const parts: string[] = [];
  if (s.sameSystem) parts.push('אותה מערכת');
  if (s.sameLocation) parts.push('אותו מיקום');
  if (s.sameDomain) parts.push('אותו תחום תקלה');
  parts.push(s.similarityBand === 'high' ? 'תיאור דומה מאוד' : 'תיאור דומה');
  return parts.join(' · ');
}

/** Maps a full Incident row to the narrower shape this module scores over --
 *  used by localRepository, which applies the open-only candidate scope
 *  itself before mapping (mirrors the SQL RPC's own WHERE clause). */
export function incidentToSimilarityCandidate(incident: Incident): SimilarityCandidate {
  return {
    incidentId: incident.id,
    number: incident.number,
    severity: incident.severity,
    status: incident.status,
    systemId: incident.systemId,
    locationId: incident.locationId,
    description: incident.description,
    reportedDomain: incident.reportedDomain,
  };
}
