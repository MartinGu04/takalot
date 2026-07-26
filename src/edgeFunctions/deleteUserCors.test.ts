// The delete-user Edge Function runs on Deno, not in this project's
// Vitest/jsdom runtime, so it can't be executed here. This is a focused
// SOURCE-level check: it reads the deployed function's actual source file
// and asserts the CORS header values directly, so a future edit that
// silently narrows Access-Control-Allow-Headers (breaking the browser
// preflight for supabase.functions.invoke()) fails a test immediately.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(__dirname, '../../supabase/functions/delete-user/index.ts'),
  'utf-8',
);

function extractCorsHeaders(): Record<string, string> {
  const match = source.match(/const CORS_HEADERS = \{([\s\S]*?)\};/);
  if (!match) throw new Error('CORS_HEADERS object not found in delete-user/index.ts');
  const headers: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/'([^']+)':\s*'([^']+)'/);
    if (kv) headers[kv[1]] = kv[2];
  }
  return headers;
}

describe('delete-user Edge Function CORS headers', () => {
  it('Access-Control-Allow-Headers includes every header supabase-js sends via functions.invoke()', () => {
    const headers = extractCorsHeaders();
    const allowed = headers['Access-Control-Allow-Headers'].split(',').map((h) => h.trim().toLowerCase());
    for (const required of ['authorization', 'x-client-info', 'apikey', 'content-type']) {
      expect(allowed).toContain(required);
    }
  });

  it('POST remains the only functional method (OPTIONS is preflight-only)', () => {
    const headers = extractCorsHeaders();
    expect(headers['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
    expect(source).toMatch(/if \(req\.method !== 'POST'\)/);
  });

  it('the OPTIONS preflight response uses the exact same CORS_HEADERS object', () => {
    expect(source).toMatch(/req\.method === 'OPTIONS'[\s\S]{0,80}headers: CORS_HEADERS/);
  });

  it('every JSON response (success and error) is built through json(), which spreads the same CORS_HEADERS', () => {
    // json() is the single response constructor used for every 2xx/4xx/5xx
    // reply in this file -- asserting its header composition once proves
    // every call site (200, 400, 401, 403, 404, 405, 409, 500, 502) is
    // covered, without having to invoke the Deno handler itself.
    const jsonFnMatch = source.match(/function json\(status: number, body: Record<string, unknown>\): Response \{([\s\S]*?)\n\}/);
    expect(jsonFnMatch).not.toBeNull();
    expect(jsonFnMatch![1]).toMatch(/headers:\s*\{\s*\.\.\.CORS_HEADERS/);

    // Every literal status code this function returns goes through
    // json(...) (403/404/409 are returned via the dynamically computed
    // `knownStatus` variable, itself passed to json(...) too -- see the
    // single call site below).
    for (const status of [200, 400, 401, 405, 500, 502]) {
      expect(source).toMatch(new RegExp(`json\\(${status},`));
    }
    expect(source).toMatch(/json\(knownStatus,/);
  });
});
