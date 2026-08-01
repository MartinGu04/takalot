// Correct Unicode Bidirectional Algorithm (UAX #9) resolution for jsPDF text
// drawing.
//
// jsPDF's own RTL support (setR2L + the isInputRtl text option) does not
// correctly interleave embedded left-to-right runs -- English names, dates,
// technical identifiers such as NET2000 -- inside right-to-left Hebrew text.
// It also double-processes any string it is given: passing an
// already-visually-ordered string back through jsPDF with isInputRtl
// true/false makes it reorder a second time (with a different assumed base
// direction), corrupting the result. The only combination that renders a
// pre-resolved string as literal glyph order is `doc.setR2L(false)` (once,
// globally) plus `{ isInputRtl: false }` on every text() call -- see
// HebrewPdf, which sets this up once so callers never touch jsPDF's bidi
// options directly.
//
// This module does the actual bidi resolution using bidi-js (a spec-
// conformant UAX #9 implementation already listed in package.json --
// unused until now), computing the true left-to-right glyph order once per
// string. HebrewPdf then draws that string with jsPDF's own bidi handling
// fully disabled, so jsPDF never reprocesses text this module already
// ordered.
import bidiFactory from 'bidi-js';

const bidi = bidiFactory();

// First Strong Isolate / Pop Directional Isolate: wrap a dynamic value so
// the bidi algorithm resolves its internal character order independently
// of, and never leaks it into, the surrounding label/punctuation text. Both
// marks are zero-width (no visible glyph) and are stripped after
// reordering -- see ISOLATE_MARKS below -- they only exist to steer the
// bidi computation itself.
const FSI = '⁨';
const PDI = '⁩';
const ISOLATE_MARKS = /[⁦-⁩]/g;

/**
 * Wrap a dynamic value -- an English name, a date/time, an email, an
 * identifier like NET2000, or Hebrew text of unknown origin -- before
 * splicing it into a Hebrew label/sentence template. This is the explicit
 * RTL/LTR isolation the export requires: correctness must not depend on
 * the bidi algorithm's implicit first-strong-character guess at the exact
 * point a value is interpolated into surrounding text.
 */
export function isolate(value: string): string {
  return `${FSI}${value}${PDI}`;
}

/**
 * Resolves `text` (which may already contain isolate() markers) into true
 * left-to-right glyph order for a paragraph whose base direction is
 * `baseDirection` (an AVARIA document is always 'rtl'). Feed the result to
 * HebrewPdf's drawing primitives, never to jsPDF's `doc.text` directly.
 */
export function resolveBidiVisual(text: string, baseDirection: 'rtl' | 'ltr' = 'rtl'): string {
  if (!text) return '';
  const embeddingLevels = bidi.getEmbeddingLevels(text, baseDirection);
  return bidi.getReorderedString(text, embeddingLevels).replace(ISOLATE_MARKS, '');
}
