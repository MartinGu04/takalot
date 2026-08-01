// Bidi run resolution for jsPDF text drawing -- exactly one bidi strategy,
// applied once, and it never reverses Hebrew (or any) character order.
//
// jsPDF's own RTL support (setR2L, and the separate isInputRtl-driven
// "BidiEngine") -- and an earlier version of this module that pre-reversed
// text with bidi-js before drawing it -- both work by physically reversing
// the character array so that a plain left-to-right glyph-placement call
// happens to *look* right-to-left when rasterized. That trick corrupts the
// PDF's actual text content: every embedded font glyph gets its own
// ToUnicode entry, and a reversed draw order writes each Hebrew *word*
// backwards into the content stream. Copy-pasting, searching, or reading
// the PDF with assistive technology then sees "חוד" where the document
// says "דוח" -- confirmed empirically while building this module (see
// pdf.ts's own comment for how the fix works from the drawing side).
//
// The correct approach draws every character in its ordinary logical
// order (so the content stream -- and therefore copy/paste/search/screen
// readers -- always matches the real Hebrew text) and instead varies each
// character's *position*: a right-to-left run's characters are placed at
// successively decreasing x, while a left-to-right run's characters keep
// their normal increasing-x placement. This module only ever computes
// *where the boundaries between direction runs are*, using the
// spec-conformant bidi-js implementation (already an installed dependency,
// previously unused) -- never how to reorder characters within them.
import bidiFactory from 'bidi-js';

const bidi = bidiFactory();

// Right-to-Left Isolate / Left-to-Right Isolate / Pop Directional Isolate:
// wrap a dynamic value so the bidi algorithm resolves its run boundaries
// independently of, and never lets them bleed into, the surrounding
// label/punctuation text. Deliberately RLI/LRI, never the auto-detecting
// FSI: every value this export isolates -- a name, a date, an identifier,
// or a composite snapshot like "Name · איש קשר: ... · פרטי קשר: ..." --
// lives inside a fundamentally Hebrew (RTL) document, and FSI's
// first-strong-character guess flips the isolate's own base direction to
// LTR whenever such a value happens to *start* with a Latin character
// (e.g. an external handler's English name), which then misplaces neutral
// punctuation (colons, the "·" separator) inside it relative to the
// Hebrew fragments alongside it -- confirmed empirically while fixing
// this.
//
// Which of RLI/LRI is correct depends on whether the value itself
// contains any strongly-directional character at all. A value with a real
// letter (Hebrew, English, whatever script) anchors its own run(s)
// regardless of the isolate's base direction, so RLI -- matching the
// surrounding document -- is correct: any genuinely left-to-right run
// inside it (an English name, an email) still gets its own correctly
// nested embedded LTR run. But a value made *only* of digits/punctuation
// -- a formatted date/time ("01.08.2026, 09:15"), a duration, an incident
// number ("2026-014") -- has no strong character to anchor it: under an
// RTL base (RLI, or no isolation at all, since it then inherits the
// document's own RTL base) the UBA's neutral-resolution rules for such
// runs misplace separators like the comma in a date/time value, moving it
// to the *start* of the value instead of directly after the date --
// confirmed empirically while fixing this. Forcing an LTR base (LRI) for
// exactly these no-strong-character values resolves them in their own,
// correct left-to-right reading order.
//
// Both isolate marks are zero-width (no visible glyph, no ToUnicode
// entry) and are dropped from every run's text -- they only steer where
// run boundaries fall, see resolveBidiRuns below.
const RLI = '⁧';
const LRI = '⁦';
const PDI = '⁩';
const ISOLATE_MARKS = new Set([RLI, LRI, PDI]);

// Matches any letter in any script. A value containing one gets RTL
// isolation (RLI); a value with none (pure digits/punctuation, e.g. a
// formatted date or an incident number) gets LTR isolation (LRI) -- see
// the comment above.
const STRONG_LETTER_RE = /\p{L}/u;

/**
 * Wrap a dynamic value -- an English name, a date/time, an email, an
 * identifier like NET2000, or Hebrew text of unknown origin -- before
 * splicing it into a Hebrew label/sentence template. This is the explicit
 * RTL/LTR isolation the export requires: correctness must not depend on
 * the bidi algorithm's implicit first-strong-character guess at the exact
 * point a value is interpolated into surrounding text. Which isolate
 * direction is used is chosen automatically per value -- see the comment
 * above RLI/LRI.
 */
export function isolate(value: string): string {
  const mark = STRONG_LETTER_RE.test(value) ? RLI : LRI;
  return `${mark}${value}${PDI}`;
}

export interface BidiRun {
  /** The run's characters, in ordinary logical (reading) order -- never
   *  reversed. Isolate marks are stripped. */
  text: string;
  /** true for a right-to-left run (draw character-by-character, each
   *  successive character placed further left); false for a left-to-right
   *  run (draw as one normal left-to-right block). */
  rtl: boolean;
}

/**
 * Splits `text` (which may contain isolate() markers) into direction runs,
 * in logical order, for a paragraph whose base direction is
 * `baseDirection` (an AVARIA document is always 'rtl'). Every run's `text`
 * is exactly the corresponding slice of the original logical string --
 * this function only ever groups and tags characters, it never reorders
 * or duplicates them.
 */
export function resolveBidiRuns(text: string, baseDirection: 'rtl' | 'ltr' = 'rtl'): BidiRun[] {
  if (!text) return [];
  const embeddingLevels = bidi.getEmbeddingLevels(text, baseDirection);
  const runs: BidiRun[] = [];
  let current: BidiRun | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ISOLATE_MARKS.has(ch)) continue;
    const rtl = (embeddingLevels.levels[i] & 1) === 1;
    if (current && current.rtl === rtl) {
      current.text += ch;
    } else {
      current = { text: ch, rtl };
      runs.push(current);
    }
  }
  return runs;
}

/** The glyph to actually draw for one character of a right-to-left run
 *  (mirrored brackets/parentheses so they still visually open/close in
 *  the direction they're read) -- the character itself, unmirrored, is
 *  still what content-stream/ToUnicode extraction should see, so callers
 *  use this only to choose what shape to draw, never to alter `text`. */
export function mirroredForRtl(char: string): string {
  return bidi.getMirroredCharacter(char) ?? char;
}
