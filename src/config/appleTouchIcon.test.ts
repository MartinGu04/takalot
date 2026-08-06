// Regression guard for the iOS "Add to Home Screen" icon. Real-device
// testing showed iOS falling back to a generated monogram instead of the
// approved AVARIA symbol -- the most likely cause was the previous
// apple-touch-icon shipping as an RGBA PNG (color type 6, alpha channel)
// with fully-opaque-but-present alpha, a known source of iOS touch-icon
// rendering quirks, plus solid-black square corners baked into the art
// instead of the approved purple background. This asserts the fixed,
// dedicated icon stays wired up: the exact <link> declaration in
// index.html, and a real 180x180 truecolor-without-alpha (color type 2)
// PNG on disk at the path it points to.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readPngHeader } from './readPngHeader';

const APPLE_TOUCH_ICON_HREF = '/icons/apple-touch-icon-180.png';

describe('Apple touch icon (iOS Add to Home Screen)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');

  it('index.html declares the dedicated 180x180 apple-touch-icon at its absolute path', () => {
    const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf-8');
    expect(html).toMatch(
      /<link\s+rel="apple-touch-icon"\s+sizes="180x180"\s+href="\/icons\/apple-touch-icon-180\.png"\s*\/>/,
    );
  });

  it.each([
    ['public/icons/apple-touch-icon-180.png', APPLE_TOUCH_ICON_HREF],
    ['public/apple-touch-icon.png', 'conventional root fallback'],
  ])('%s is a real, square, alpha-free 180x180 PNG (%s)', (relativePath) => {
    const filePath = path.join(repoRoot, relativePath);
    expect(fs.existsSync(filePath)).toBe(true);

    const header = readPngHeader(filePath);
    expect(header.width).toBe(180);
    expect(header.height).toBe(180);
    // No alpha channel at all -- guarantees no transparent corner can ever
    // reach iOS, sidestepping the RGBA touch-icon quirk this fix targets.
    expect(header.colorType).toBe(2);
  });
});
