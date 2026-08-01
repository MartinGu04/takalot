// The embedded Alef font has no glyph at all for "←" (U+2190) -- confirmed
// empirically across every common arrow/directional codepoint (→ ↑ ↓ ↔ ⇐ ⇒
// ▶ ◀ …): jsPDF produces a completely empty glyph-show payload for all of
// them, because the font's own cmap simply has no entry there. That makes
// the character both invisible when drawn (pdf.ts overlays a small vector
// arrow to fix that) and unrecoverable by a text extractor, since a PDF's
// ToUnicode mapping only ever applies to a glyph that was actually shown.
//
// ARROW_GLYPH_HEX is a deliberately out-of-range CID (0xFFFE) for this
// font's subset: no glyph outline exists there, so every PDF renderer
// tested (poppler) draws nothing for it -- verified directly, not assumed
// -- exactly like the real "←" glyph already does. Using it as a stand-in
// glyph, combined with patchArrowToUnicode() adding one ToUnicode bfchar
// entry mapping that CID to U+2190, makes the timeline's transition
// separator ("סטטוס שונה: חדשה ← בטיפול") both render correctly (via
// pdf.ts's vector overlay) and extract/copy/search as the real arrow
// character, without touching any other glyph's mapping.
//
// The document embeds two font instances (Alef regular and bold), each
// with its own ToUnicode CMap object -- the arrow can be drawn through
// either (currently only the bold one, for timeline titles), so every
// CMap object found is patched, not just the first; the added entry is a
// no-op for a font that never actually shows that CID.
//
// This module works purely with Uint8Array/binary-safe strings (one
// character per byte, code points 0-255) instead of Node's Buffer: it
// runs in the browser, where the actual PDF export happens, not just in
// tests.
export const ARROW_GLYPH_HEX = '<FFFE>';

function bytesToBinaryString(bytes: Uint8Array): string {
  let result = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return result;
}

function binaryStringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

const TRAILER_RE = /trailer\s*\r?\n?<<([\s\S]*?)>>\s*startxref/;
const STARTXREF_RE = /startxref\s+(\d+)\s+%%EOF\s*$/;
const OBJ_HEADER_RE = /(\d+)\s+0\s+obj/g;
const BEGINBFCHAR_RE = /beginbfchar/g;

interface PatchedObject {
  objNum: string;
  content: string;
}

/** Finds every `N 0 obj << ... beginbfchar ... >> stream ... endstream
 *  endobj` ToUnicode CMap object and returns each one's object number and
 *  patched stream content (with one extra bfchar entry appended) -- or an
 *  empty array if the document's structure doesn't match what jsPDF is
 *  known to emit. */
function findPatchedCMapObjects(text: string): PatchedObject[] {
  const results: PatchedObject[] = [];
  for (const bfcharMatch of text.matchAll(BEGINBFCHAR_RE)) {
    const bfcharIndex = bfcharMatch.index;

    let objNum: string | null = null;
    let objStart = -1;
    for (const objMatch of text.matchAll(OBJ_HEADER_RE)) {
      if (objMatch.index === undefined || objMatch.index > bfcharIndex) break;
      objNum = objMatch[1];
      objStart = objMatch.index;
    }
    if (!objNum || objStart === -1) continue;

    const streamKeywordIndex = text.indexOf('stream', objStart);
    const streamContentStart = text.indexOf('\n', streamKeywordIndex) + 1;
    const endstreamIndex = text.indexOf('endstream', streamContentStart);
    if (streamKeywordIndex === -1 || streamContentStart === 0 || endstreamIndex === -1) continue;

    const originalContent = text.slice(streamContentStart, endstreamIndex).replace(/\r?\n$/, '');
    const patchedContent = originalContent.replace(
      /(\d+)\s+beginbfchar/,
      (_full, count: string) => `${Number(count) + 1} beginbfchar\n${ARROW_GLYPH_HEX}<2190>`,
    );
    if (patchedContent === originalContent) continue;

    results.push({ objNum, content: patchedContent });
  }
  return results;
}

/**
 * Appends a standard PDF incremental update (new objects + a minimal new
 * xref/trailer with /Prev pointing at the original one) that overrides
 * every ToUnicode CMap object in the document with one extra bfchar entry
 * mapping ARROW_GLYPH_HEX to U+2190. Every byte of the original PDF is
 * left untouched; this only ever appends. If the document's structure
 * doesn't match what jsPDF is known to emit (uncompressed, one or more
 * ToUnicode CMap streams, a simple trailer) -- e.g. a future jsPDF version
 * changes its output format -- this safely returns the original bytes
 * unchanged rather than risk producing a corrupt PDF.
 */
export function patchArrowToUnicode(bytes: Uint8Array): Uint8Array {
  const text = bytesToBinaryString(bytes);

  const startxrefMatch = text.match(STARTXREF_RE);
  const trailerMatch = text.match(TRAILER_RE);
  if (!startxrefMatch || !trailerMatch) return bytes;

  const originalXrefOffset = Number(startxrefMatch[1]);
  const sizeMatch = trailerMatch[1].match(/\/Size\s+\d+/);
  const rootMatch = trailerMatch[1].match(/\/Root\s+\d+\s+\d+\s+R/);
  if (!sizeMatch || !rootMatch) return bytes;

  const patched = findPatchedCMapObjects(text);
  if (patched.length === 0) return bytes;

  let cursor = bytes.length;
  const newObjectStrings: string[] = [];
  const xrefEntries: string[] = [];
  for (const { objNum, content } of patched) {
    const newObject = `${objNum} 0 obj\n<<\n/Length ${content.length}\n/Length1 ${content.length}\n>>\nstream\n${content}\nendstream\nendobj\n`;
    newObjectStrings.push(newObject);
    xrefEntries.push(`${objNum} 1\n${String(cursor).padStart(10, '0')} 00000 n \n`);
    cursor += newObject.length;
  }

  const newXref =
    `xref\n${xrefEntries.join('')}` +
    `trailer\n<<\n${sizeMatch[0]}\n${rootMatch[0]}\n/Prev ${originalXrefOffset}\n>>\n` +
    `startxref\n${cursor}\n%%EOF`;

  const appended = newObjectStrings.join('') + newXref;
  const appendedBytes = binaryStringToBytes(appended);
  const result = new Uint8Array(bytes.length + appendedBytes.length);
  result.set(bytes, 0);
  result.set(appendedBytes, bytes.length);
  return result;
}
