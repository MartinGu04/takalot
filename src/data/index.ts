// Repository provider. Demo mode is used whenever Supabase credentials are
// absent, and is clearly indicated in the UI ("מצב הדגמה").
import type { Repository } from './repository';
import { LocalDemoRepository } from './local/localRepository';
import { BrowserStorage } from './local/storage';
import { SupabaseRepository } from './supabase/supabaseRepository';

let instance: Repository | null = null;

export function getRepository(): Repository {
  if (instance) return instance;
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (url && anonKey) {
    instance = new SupabaseRepository(url, anonKey);
  } else {
    instance = new LocalDemoRepository(new BrowserStorage());
  }
  return instance;
}

export function isDemoMode(): boolean {
  return getRepository().mode === 'demo';
}
