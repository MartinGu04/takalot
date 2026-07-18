// Mode resolution: supabase with real credentials, demo only as an explicit
// (or development-implicit) fallback, and hard misconfiguration everywhere
// else. Production must never silently fall back to demo data.
//
// The environment contract is exactly VITE_SUPABASE_URL +
// VITE_SUPABASE_PUBLISHABLE_KEY -- no alias variable names, no fallback
// between differently named variables.
import { describe, expect, it } from 'vitest';
import { resolveAppModeForTest } from './appMode';

// A structurally valid legacy public key (JWT shape, role=anon payload).
const PUBLIC_JWT = ['h', btoa(JSON.stringify({ role: 'anon' })), 's'].join('.');
const SERVICE_JWT = ['h', btoa(JSON.stringify({ role: 'service_role' })), 's'].join('.');

const URL_OK = 'https://example.supabase.co';

describe('app mode resolution', () => {
  it('selects supabase mode with a valid URL and publishable key', () => {
    const mode = resolveAppModeForTest({
      VITE_SUPABASE_URL: URL_OK,
      VITE_SUPABASE_PUBLISHABLE_KEY: PUBLIC_JWT,
      PROD: true,
    });
    expect(mode).toEqual({ kind: 'supabase', url: URL_OK, publishableKey: PUBLIC_JWT });
  });

  it('accepts new-style publishable keys', () => {
    const mode = resolveAppModeForTest({
      VITE_SUPABASE_URL: URL_OK,
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc123',
      PROD: true,
    });
    expect(mode.kind).toBe('supabase');
  });

  it('is misconfigured (never demo) in a production build with no configuration', () => {
    const mode = resolveAppModeForTest({ PROD: true });
    expect(mode.kind).toBe('misconfigured');
  });

  it('is misconfigured when only one of the two variables is set', () => {
    expect(resolveAppModeForTest({ VITE_SUPABASE_URL: URL_OK, PROD: true }).kind).toBe('misconfigured');
    expect(
      resolveAppModeForTest({ VITE_SUPABASE_PUBLISHABLE_KEY: PUBLIC_JWT, PROD: false }).kind,
    ).toBe('misconfigured');
  });

  it('is misconfigured for a non-https or unparseable URL', () => {
    expect(
      resolveAppModeForTest({
        VITE_SUPABASE_URL: 'http://example.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: PUBLIC_JWT,
      }).kind,
    ).toBe('misconfigured');
    expect(
      resolveAppModeForTest({ VITE_SUPABASE_URL: 'not a url', VITE_SUPABASE_PUBLISHABLE_KEY: PUBLIC_JWT }).kind,
    ).toBe('misconfigured');
  });

  it('refuses a service-role key in the client variable (legacy JWT and new-style secret)', () => {
    const legacy = resolveAppModeForTest({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: SERVICE_JWT });
    expect(legacy.kind).toBe('misconfigured');
    const modern = resolveAppModeForTest({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abc' });
    expect(modern.kind).toBe('misconfigured');
  });

  it('enables demo mode with the explicit flag, even in production builds (opt-in beats ambient state)', () => {
    expect(resolveAppModeForTest({ VITE_DEMO_MODE: 'true', PROD: true }).kind).toBe('demo');
    expect(
      resolveAppModeForTest({
        VITE_DEMO_MODE: 'true',
        VITE_SUPABASE_URL: URL_OK,
        VITE_SUPABASE_PUBLISHABLE_KEY: PUBLIC_JWT,
      }).kind,
    ).toBe('demo');
  });

  it('falls back to demo only in non-production builds when nothing is configured', () => {
    expect(resolveAppModeForTest({ PROD: false }).kind).toBe('demo');
  });
});
