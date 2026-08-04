import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Regression guard: without a catch-all SPA rewrite, Vercel serves its own
// 404 for any direct request to a client-side route (e.g. /login, /personnel)
// or for the OAuth redirect back to /login?code=... -- the React app never
// loads, so the Supabase PKCE code is never processed.
describe('vercel.json SPA fallback', () => {
  const configPath = resolve(process.cwd(), 'vercel.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));

  it('rewrites every path to index.html so client-side routes are served', () => {
    expect(Array.isArray(config.rewrites)).toBe(true);
    const catchAll = config.rewrites.find(
      (r: { source: string; destination: string }) => r.destination === '/index.html',
    );
    expect(catchAll).toBeTruthy();
    expect(catchAll.source).toBe('/(.*)');
  });
});

describe('vercel.json Security Headers', () => {
  const configPath = resolve(process.cwd(), 'vercel.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));

  it('contains essential security headers', () => {
    expect(Array.isArray(config.headers)).toBe(true);
    const rootHeaders = config.headers.find(
      (h: { source: string }) => h.source === '/(.*)',
    );
    expect(rootHeaders).toBeTruthy();
    expect(Array.isArray(rootHeaders.headers)).toBe(true);

    const keys = rootHeaders.headers.map((item: { key: string }) => item.key);
    expect(keys).toContain('Content-Security-Policy');
    expect(keys).toContain('X-Frame-Options');
    expect(keys).toContain('X-Content-Type-Options');
    expect(keys).toContain('Referrer-Policy');
    expect(keys).toContain('Permissions-Policy');
    expect(keys).toContain('Strict-Transport-Security');
  });
});
