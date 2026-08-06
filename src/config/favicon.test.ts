// Regression guard for the browser-tab favicon set. These files carried the
// same defect fixed for the Apple touch icon: the approved mark's baked-in
// solid-black square corners (a matte around its rounded tile, never meant
// to render as-is) instead of the tile's own purple background. This
// asserts index.html still references the existing (unchanged) paths, and
// that each file on disk is a real, correctly-sized, alpha-free PNG --
// alpha-free specifically guards against the black-corner regression
// reappearing (a transparent corner would let black show through instead
// of the approved purple).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readPngHeader } from './readPngHeader';

describe('Favicon set', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf-8');

  it('index.html declares all four existing favicon links, unchanged paths', () => {
    expect(html).toMatch(/<link\s+rel="icon"\s+href="\/favicon-backed\.ico"\s+sizes="any"\s*\/>/);
    expect(html).toMatch(
      /<link\s+rel="icon"\s+type="image\/png"\s+sizes="16x16"\s+href="\/favicon-backed-16x16\.png"\s*\/>/,
    );
    expect(html).toMatch(
      /<link\s+rel="icon"\s+type="image\/png"\s+sizes="32x32"\s+href="\/favicon-backed-32x32\.png"\s*\/>/,
    );
    expect(html).toMatch(
      /<link\s+rel="icon"\s+type="image\/png"\s+sizes="48x48"\s+href="\/favicon-backed-48x48\.png"\s*\/>/,
    );
  });

  it.each([
    ['public/favicon-backed-16x16.png', 16],
    ['public/favicon-backed-32x32.png', 32],
    ['public/favicon-backed-48x48.png', 48],
  ])('%s is a real, square, alpha-free %ipx PNG', (relativePath, size) => {
    const filePath = path.join(repoRoot, relativePath);
    expect(fs.existsSync(filePath)).toBe(true);

    const header = readPngHeader(filePath);
    expect(header.width).toBe(size);
    expect(header.height).toBe(size);
    expect(header.colorType).toBe(2);
  });

  it('favicon-backed.ico exists and contains the standard 16/32/48 sizes', () => {
    const filePath = path.join(repoRoot, 'public/favicon-backed.ico');
    expect(fs.existsSync(filePath)).toBe(true);

    const buf = fs.readFileSync(filePath);
    // ICO header: reserved(2)=0, type(2)=1 (icon), count(2)=number of images.
    expect(buf.readUInt16LE(0)).toBe(0);
    expect(buf.readUInt16LE(2)).toBe(1);
    const count = buf.readUInt16LE(4);
    expect(count).toBe(3);

    // Each 16-byte directory entry: width(1) height(1) ... starting at
    // offset 6. A width/height byte of 0 conventionally means 256px, which
    // none of these entries should be.
    const sizes = new Set<number>();
    for (let i = 0; i < count; i++) {
      const entryOffset = 6 + i * 16;
      const width = buf.readUInt8(entryOffset) || 256;
      const height = buf.readUInt8(entryOffset + 1) || 256;
      expect(width).toBe(height);
      sizes.add(width);
    }
    expect(sizes).toEqual(new Set([16, 32, 48]));
  });
});
