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
