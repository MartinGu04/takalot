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

// Right-to-Left Isolate / Pop Directional Isolate: wrap a dynamic value so
// the bidi algorithm resolves its run boundaries independently of, and
// never lets them bleed into, the surrounding label/punctuation text.
// Deliberately RLI, not the auto-detecting FSI: every value this export
// isolates -- a name, a date, an identifier, or a composite snapshot like
// "Name · איש קשר: ... · פרטי קשר: ..." -- lives inside a fundamentally
// Hebrew (RTL) document, and FSI's first-strong-character guess flips the
// isolate's own base direction to LTR whenever such a value happens to
// *start* with a Latin character (e.g. an external handler's English
// name), which then misplaces neutral punctuation (colons, the "·"
// separator) inside it relative to the Hebrew fragments alongside it --
// confirmed empirically while fixing this. RLI keeps the isolate's base
// direction RTL, matching the surrounding document, while any genuinely
// left-to-right run inside it (the English name, the email) still gets
// its own correctly nested embedded LTR run regardless. Both marks are
// zero-width (no visible glyph, no ToUnicode entry) and are dropped from
// every run's text -- they only steer where run boundaries fall, see
// resolveBidiRuns below.
const RLI = '⁧';
const PDI = '⁩';
const ISOLATE_MARKS = new Set([RLI, PDI]);

/**
 * Wrap a dynamic value -- an English name, a date/time, an email, an
 * identifier like NET2000, or Hebrew text of unknown origin -- before
 * splicing it into a Hebrew label/sentence template. This is the explicit
 * RTL/LTR isolation the export requires: correctness must not depend on
 * the bidi algorithm's implicit first-strong-character guess at the exact
 * point a value is interpolated into surrounding text.
 */
export function isolate(value: string): string {
  return `${RLI}${value}${PDI}`;
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
