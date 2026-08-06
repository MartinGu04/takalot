// Minimal PNG IHDR parser used only by asset regression tests (favicon,
// apple-touch-icon) that need to assert real dimensions/color-type on disk
// without pulling in an image-decoding dependency.
import fs from 'node:fs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  // PNG color types: 0 grayscale, 2 truecolor (RGB, no alpha), 3 indexed,
  // 4 grayscale+alpha, 6 truecolor+alpha (RGBA).
  colorType: number;
}

export function readPngHeader(filePath: string): PngHeader {
  const buf = fs.readFileSync(filePath);
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${filePath} is not a valid PNG (bad signature)`);
  }
  // IHDR is always the first chunk: 4-byte length, 4-byte type "IHDR", then
  // width(4) height(4) bitDepth(1) colorType(1) compression(1) filter(1) interlace(1).
  const ihdrType = buf.subarray(12, 16).toString('ascii');
  if (ihdrType !== 'IHDR') {
    throw new Error(`${filePath} has no leading IHDR chunk`);
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf.readUInt8(24),
    colorType: buf.readUInt8(25),
  };
}
