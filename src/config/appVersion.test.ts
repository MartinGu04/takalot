// Regression guard for the single build-time version source of truth
// (vite.config.ts `define` -> __APP_VERSION__ -> this module). Reads
// package.json directly (same technique as vercelConfig.test.ts) so this
// test fails the moment the built-in constant and the package version ever
// drift apart, rather than trusting a duplicated literal.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_VERSION, APP_VERSION_LABEL } from './appVersion';

describe('appVersion: single source of truth', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));

  it('APP_VERSION matches package.json exactly, with no independently hardcoded value', () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('package.json declares a valid semantic version', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('APP_VERSION_LABEL renders as "AVARIA v<version>", matching whatever version package.json currently declares', () => {
    expect(APP_VERSION_LABEL).toBe(`AVARIA v${pkg.version}`);
  });
});
