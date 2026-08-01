import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Poppler's own directional-formatting marks (inserted by pdftotext itself
// when reconstructing a bidi line for display) and this export's own
// invisible RLM disambiguation marks (see pdf.ts's drawBidiLine) -- none of
// them are visible, meaningful to a reader, or something a real search/copy
// would include, so tests comparing against expected readable text strip
// them, exactly like a human eyeballing the extracted text would.
// U+200E/U+200F (LRM/RLM), U+202A-U+202E (LRE/RLE/PDF/LRO/RLO), U+2066-U+2069
// (LRI/RLI/FSI/PDI) -- built from code points, not literal characters,
// since every one of them is invisible/zero-width in a normal editor.
const BIDI_FORMAT_CODEPOINTS = [
  ...[0x200e, 0x200f],
  ...[0x202a, 0x202b, 0x202c, 0x202d, 0x202e],
  ...[0x2066, 0x2067, 0x2068, 0x2069],
];
const BIDI_FORMAT_CHARS = new RegExp(
  `[${BIDI_FORMAT_CODEPOINTS.map((cp) => String.fromCharCode(cp)).join('')}]`,
  'g',
);

let cachedAvailability: boolean | null = null;

/** Whether poppler's pdftotext binary is on PATH in this environment --
 *  tests that depend on real external-extractor validation should skip
 *  (not fail) when it isn't, rather than fall back to a weaker check. */
export function pdftotextAvailable(): boolean {
  if (cachedAvailability !== null) return cachedAvailability;
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    cachedAvailability = true;
  } catch {
    cachedAvailability = false;
  }
  return cachedAvailability;
}

/**
 * Extracts a PDF's text the way a real external tool -- not jsPDF's own
 * internal draw calls -- would: via poppler's pdftotext, the same ground
 * truth used to diagnose and fix this export's extraction bugs (spaced-out
 * Hebrew letters, reordered mixed-language values, misplaced punctuation).
 */
export function extractPdfText(bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdftotext-'));
  const pdfPath = join(dir, 'doc.pdf');
  try {
    writeFileSync(pdfPath, bytes);
    const out = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
    return out.replace(BIDI_FORMAT_CHARS, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
