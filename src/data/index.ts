// Repository provider. Mode selection lives in appMode.ts: 'supabase' with
// real credentials, 'demo' only as an explicit development/test fallback,
// and 'misconfigured' (surfaced as a hard error screen by App.tsx -- this
// module must never be reached in that state).
import type { Repository } from './repository';
import { LocalDemoRepository } from './local/localRepository';
import { BrowserStorage } from './local/storage';
import { SupabaseRepository } from './supabase/supabaseRepository';
import { getSupabaseClient } from './supabase/client';
import { getAppMode } from './appMode';

let instance: Repository | null = null;

export function getRepository(): Repository {
  if (instance) return instance;
  const mode = getAppMode();
  if (mode.kind === 'supabase') {
    instance = new SupabaseRepository(getSupabaseClient());
  } else if (mode.kind === 'demo') {
    instance = new LocalDemoRepository(new BrowserStorage());
  } else {
    // App.tsx renders the configuration-error screen before any repository
    // consumer mounts; reaching here means that gate was bypassed.
    throw new Error(`Application misconfigured: ${mode.reason}`);
  }
  return instance;
}

export function isDemoMode(): boolean {
  return getAppMode().kind === 'demo';
}
