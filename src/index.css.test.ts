// Focused checks for the live severity-pulse CSS (critical/high accents on
// the current-state/home view) and its reduced-motion behavior. These rules
// can't be exercised through jsdom's rendering (it doesn't evaluate CSS media
// queries or run animations), so this asserts directly against the
// stylesheet source instead.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.join(__dirname, 'index.css'), 'utf-8');

describe('severity pulse CSS', () => {
  it('defines a static amber/orange accent for high severity, distinct from the critical red one', () => {
    expect(css).toMatch(/\.incident-card-accent-high\s*\{[^}]*border-s-orange-500/);
    expect(css).toMatch(/\.incident-card-accent-critical\s*\{[^}]*border-s-red-500/);
  });

  it('defines separate looping pulse animations for critical (red) and high (amber/orange)', () => {
    expect(css).toMatch(/\.incident-card-pulse-critical\s*\{\s*animation:\s*incident-pulse-critical[^;]*infinite/);
    expect(css).toMatch(/\.incident-card-pulse-high\s*\{\s*animation:\s*incident-pulse-high[^;]*infinite/);
    expect(css).toMatch(/@keyframes incident-pulse-critical/);
    expect(css).toMatch(/@keyframes incident-pulse-high/);
  });

  it('the pulse keyframes only vary box-shadow/border-color -- never opacity, transform, or scale', () => {
    const criticalBlock = css.match(/@keyframes incident-pulse-critical\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const highBlock = css.match(/@keyframes incident-pulse-high\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    for (const block of [criticalBlock, highBlock]) {
      expect(block).not.toMatch(/opacity/);
      expect(block).not.toMatch(/transform/);
      expect(block).not.toMatch(/scale/);
    }
  });

  it('disables the pulse entirely under prefers-reduced-motion, falling back to the plain static shadow', () => {
    const reducedMotionBlock = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}\n/)?.[1] ?? '';
    expect(reducedMotionBlock).toMatch(
      /\.incident-card-pulse-critical,\s*\.incident-card-pulse-high\s*\{\s*animation:\s*none;\s*box-shadow:\s*var\(--shadow-soft\);/,
    );
    // Belt-and-suspenders: the blanket rule for every element is still in
    // place, so even a class-specific override that regressed would still
    // be caught by animation-duration collapsing to ~0.
    expect(reducedMotionBlock).toMatch(/animation-duration:\s*0\.001ms\s*!important/);
  });
});

describe('similar-incident suggestion entrance glow (incident creation only)', () => {
  it('plays once (no infinite/looping) and is short (1-2s)', () => {
    const rule = css.match(/\.suggestion-panel-entrance\s*\{\s*animation:\s*suggestion-panel-glow\s+([^;]+);/)?.[1] ?? '';
    expect(rule).not.toMatch(/infinite/);
    const seconds = Number(rule.match(/(\d+(?:\.\d+)?)s/)?.[1]);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(2);
  });

  it('the glow keyframes only vary box-shadow -- never opacity, transform, or scale', () => {
    const block = css.match(/@keyframes suggestion-panel-glow\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(block).toMatch(/box-shadow/);
    expect(block).not.toMatch(/opacity/);
    expect(block).not.toMatch(/transform/);
    expect(block).not.toMatch(/scale/);
  });

  it('disables the entrance glow entirely under prefers-reduced-motion', () => {
    const reducedMotionBlock = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}\n/)?.[1] ?? '';
    expect(reducedMotionBlock).toMatch(/\.suggestion-panel-entrance\s*\{\s*animation:\s*none;\s*\}/);
  });
});
